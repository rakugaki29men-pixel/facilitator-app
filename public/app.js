import { loadSettings, renderSettings, ttsInstructions } from "./settings.js";
import { buildSystemPrompt, buildUserMessage } from "./prompt.js";
import { Listener, speak, stopSpeaking, unlockAudio, isRecognitionSupported } from "./speech.js";

const $ = (sel) => document.querySelector(sel);

const settings = loadSettings();

// 合言葉はこの端末のブラウザにだけ保存する（設定とは別。AIへの指示文には入れない）
const PASSCODE_KEY = "facilitator-passcode";
function passcode() {
  try {
    return localStorage.getItem(PASSCODE_KEY) || "";
  } catch {
    return $("#passcode").value;
  }
}

const state = {
  running: false,
  startedAt: 0,
  lastCheckAt: 0, // 前回AIに判断させた時刻。これ以降の聞き取りが「直近」
  lastVoiceAt: 0, // 最後に誰かの声（途中経過を含む）を聞き取った時刻。沈黙の検知に使う
  busy: false, // AI問い合わせ中
  speaking: false, // 読み上げ中
  pendingNext: false, // 問い合わせ中に「次へ」が押された
  heard: [], // {at, text}
  aiHistory: [], // {at, text}
};

// ---- 表示 ----
function setStatus(text, kind = "") {
  const node = $("#status");
  node.textContent = text;
  node.dataset.kind = kind;
}

function refreshStatus() {
  if (!state.running) return setStatus("停止中", "idle");
  if (state.speaking) return setStatus("🔊 しゃべっています（聞き取り停止中）", "speaking");
  if (state.busy) return setStatus("🤔 AIが考え中…", "thinking");
  setStatus("🎤 聞き取り中", "listening");
}

function log(kind, text, note = "") {
  const list = $("#log");
  const time = new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const item = document.createElement("li");
  item.className = `log-${kind}`;
  const t = document.createElement("time");
  t.textContent = time;
  const body = document.createElement("span");
  body.textContent = text;
  item.append(t, body);
  if (note) {
    const n = document.createElement("small");
    n.textContent = note;
    item.append(n);
  }
  list.prepend(item);
  while (list.children.length > 200) list.lastChild.remove();
}

function refreshPromptPreview() {
  $("#prompt-preview").textContent = buildSystemPrompt(settings);
}

// ---- 聞き取り ----
const listener = new Listener({
  onFinal(text) {
    if (state.speaking) return;
    state.lastVoiceAt = Date.now();
    state.heard.push({ at: state.lastVoiceAt, text });
    if (state.heard.length > 300) state.heard.shift();
    log("heard", text);
  },
  onInterim(text) {
    $("#interim").textContent = text;
    if (text && !state.speaking) state.lastVoiceAt = Date.now();
  },
  onState(s) {
    if (s.startsWith("error:")) log("error", `音声認識: ${s.slice(6)}`);
    // マイクが使えないまま進行すると「聞いていないのにしゃべる」状態になるので止める
    if (s.includes("許可されていません") && state.running) {
      log("error", "マイクを許可してから、もう一度「開始」を押してください（アドレスバー左のアイコン →「権限」→ マイク）。");
      stop();
      return;
    }
    refreshStatus();
  },
});

// ---- しゃべる ----
function voiceOptions() {
  const a = settings.audio;
  return {
    engine: a.engine,
    voice: a.openaiVoice,
    instructions: ttsInstructions(settings),
    passcode: passcode(),
    voiceURI: a.voiceURI,
    rate: a.rate,
    pitch: a.pitch,
    onFallback: (err) => log("error", `OpenAIの声が使えないのでブラウザの声で代用します: ${err.message}`),
  };
}

async function say(text, reason = "") {
  state.speaking = true;
  listener.pause();
  refreshStatus();
  log("ai", text, reason);
  state.aiHistory.push({ at: Date.now(), text });
  if (state.aiHistory.length > 8) state.aiHistory.shift();

  await speak(text, voiceOptions());
  // 残響を拾わないよう少し待ってから聞き取りを再開
  await new Promise((r) => setTimeout(r, 600));

  state.speaking = false;
  // 発言直後にすぐ次の判断をしないよう、タイマーをここから数え直す。沈黙の数え直しも同じ
  state.lastCheckAt = state.lastVoiceAt = Date.now();
  if (state.running) listener.resume();
  refreshStatus();
}

// ---- AIに判断させる ----
async function check(mode) {
  if (state.busy) {
    if (mode === "next") state.pendingNext = true;
    return;
  }
  state.busy = true;
  refreshStatus();

  const now = Date.now();
  const recentHeard = state.heard.filter((h) => h.at > state.lastCheckAt);
  const earlierHeard = state.heard.filter((h) => h.at <= state.lastCheckAt && h.at > now - 3 * 60_000).slice(-15);
  state.lastCheckAt = now;

  try {
    const res = await fetch("/api/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Passcode": passcode() },
      body: JSON.stringify({
        system: buildSystemPrompt(settings),
        user: buildUserMessage({
          mode,
          recentHeard,
          earlierHeard,
          aiHistory: state.aiHistory,
          startedAt: state.startedAt,
          now,
          silentSec: Math.round((now - state.lastVoiceAt) / 1000),
        }),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    if (!state.running) return;
    // 読み上げが終わるまで busy のままにして、発話が重ならないようにする
    if (data.speak && data.utterance.trim()) {
      await say(data.utterance.trim(), data.reason);
    } else {
      log("skip", "（見送り）", data.reason);
    }
  } catch (err) {
    log("error", `AI判断に失敗: ${err.message}`);
  } finally {
    state.busy = false;
    refreshStatus();
    if (state.pendingNext && state.running) {
      state.pendingNext = false;
      check("next");
    }
  }
}

// 1秒ごとに「AIに聞く時間か」を確認する。聞くきっかけは2つ：
//  ・沈黙：誰の声も聞こえない状態が silenceSec 秒続いた → 必ず話題を振らせる
//  ・定期：前回の判断から intervalSec 秒たった → 割り込むかどうかはAIが決める（見送りもある）
const MIN_GAP_MS = 10_000; // 沈黙で連続して呼ばないための最短間隔
setInterval(() => {
  if (!state.running || state.busy || state.speaking) return;
  const now = Date.now();
  const { silenceSec, intervalSec } = settings.audio;
  if (silenceSec > 0 && now - state.lastVoiceAt >= silenceSec * 1000 && now - state.lastCheckAt >= MIN_GAP_MS) {
    check("silence");
  } else if (now - state.lastCheckAt >= intervalSec * 1000) {
    check("auto");
  }
}, 1000);

// ---- ボタン ----
function start() {
  if (!passcode()) {
    log("error", "先に設定欄の「合言葉」を入力してください。");
    $("#passcode").focus();
    return;
  }
  if (!isRecognitionSupported) {
    log("error", "このブラウザは音声認識に対応していません。Chrome か Edge を使ってください。");
    return;
  }
  state.running = true;
  state.startedAt = state.lastCheckAt = state.lastVoiceAt = Date.now();
  unlockAudio(); // 開始ボタンを押した今のうちに、あとからの自動再生を許可してもらう
  $("#start").hidden = true;
  $("#stop").hidden = false;
  $("#next").disabled = false;
  listener.start();
  log("system", "開始しました");
  check("start");
}

function stop() {
  state.running = false;
  state.pendingNext = false;
  listener.stop();
  stopSpeaking();
  $("#start").hidden = false;
  $("#stop").hidden = true;
  $("#next").disabled = true;
  log("system", "停止しました");
  refreshStatus();
}

$("#start").addEventListener("click", start);
$("#stop").addEventListener("click", stop);
$("#next").addEventListener("click", () => {
  if (!state.running) return;
  log("system", "幹事が「次へ」を押しました");
  // しゃべり中なら打ち切る。読み上げ完了後に pendingNext として処理される
  if (state.speaking) stopSpeaking();
  check("next");
});

$("#voice-test").addEventListener("click", () => {
  unlockAudio();
  const { firstPerson, ending } = settings.speech;
  speak(`${firstPerson || "わたし"}が今日の司会です。よろしくお願いします${ending ? `、${ending.replace(/^〜/, "")}` : ""}。`, voiceOptions());
});

// 手入力で「聞き取った」ことにする（マイクなしでの動作確認用）
$("#manual").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#manual-text");
  const text = input.value.trim();
  if (!text) return;
  state.lastVoiceAt = Date.now();
  state.heard.push({ at: state.lastVoiceAt, text });
  log("heard", text, "手入力");
  input.value = "";
});

// ---- 初期化 ----
$("#passcode").value = passcode();
$("#passcode").addEventListener("input", (e) => {
  try {
    localStorage.setItem(PASSCODE_KEY, e.target.value);
  } catch {
    // 保存できなくても、入力欄の値をそのまま使う
  }
});
renderSettings($("#settings"), settings, refreshPromptPreview);
refreshPromptPreview();
refreshStatus();
if (!isRecognitionSupported) log("error", "このブラウザは音声認識に対応していません。Chrome か Edge を使ってください。");
