import { loadSettings, saveSettings, renderSettings, ttsInstructions, characterView } from "./settings.js";
import { targetTension, tensionInfo, clampLevel, browserVoiceFactor } from "./tension.js";
import { drawTargets } from "./pokes.js";
import { drawLaugh, laughInfo } from "./laugh.js";
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
  speaking: false, // 読み上げ処理中（声の準備中を含む）
  talking: false, // 実際に声が出ている
  pendingNext: false, // 問い合わせ中に「次へ」が押された
  heard: [], // {at, text}
  aiHistory: [], // {at, text}
  tension: null, // 最後にしゃべったときのテンション(1〜5)。まだなら null
  lastTargets: [], // 前回のセリフで絡んだ人の名前（連続して絡まないための記録）
};

// ---- 画面の切り替え ----
// 設定画面(#setup-view)とトーク中画面(#stage)。進行中も「⚙ 設定」で設定を重ねて開ける。
function updateView({ settingsOpen = false } = {}) {
  const inStage = state.running;
  $("#stage").hidden = !inStage;
  $("#setup-view").hidden = inStage && !settingsOpen;
  $("#setup-view").classList.toggle("overlay", inStage);
  $("#start").hidden = inStage;
  $("#close-settings").hidden = !inStage;
  if (inStage && !settingsOpen) {
    renderStage();
    renderTension();
  }
  window.scrollTo(0, 0);
}

function renderStage() {
  const { icon, name } = characterView(settings);
  $("#avatar").textContent = icon;
  $("#char-name").textContent = name;
  $("#event-name").textContent = settings.event.name;
}

// テンション表示と、幹事用の ▼▲。基準のテンションを会の途中で上下できる
function renderTension() {
  const cfg = settings.tension;
  const level = state.tension ?? clampLevel(cfg.base);
  $("#tension-text").textContent = `🔥 ${"●".repeat(level)}${"○".repeat(5 - level)}　${tensionInfo(level).label}`;
  $("#tension-hint").textContent = { swing: "毎回ランダムに急変中", ramp: "だんだん盛り上げ中", ai: "AIおまかせ", steady: "" }[cfg.mode] ?? "";
  const adjustable = cfg.mode !== "swing";
  $("#tension-down").disabled = !adjustable || cfg.base <= 1;
  $("#tension-up").disabled = !adjustable || cfg.base >= 5;
}

function adjustTension(delta) {
  settings.tension.base = clampLevel(settings.tension.base + delta);
  saveSettings(settings);
  if (settings.tension.mode === "steady") state.tension = null; // 基準がそのまま表示に出る
  renderSettings($("#settings"), settings, onSettingsChange); // 設定画面のスライダーも合わせる
  onSettingsChange();
}

function onSettingsChange() {
  refreshPromptPreview();
  if (state.running) renderTension();
}

function setupMessage(text) {
  const node = $("#setup-msg");
  node.textContent = text;
  node.hidden = !text;
}

let alertTimer = null;
function stageAlert(text) {
  const node = $("#stage-alert");
  node.textContent = text;
  node.hidden = false;
  clearTimeout(alertTimer);
  alertTimer = setTimeout(() => (node.hidden = true), 12_000);
}

// ---- 表示 ----
function refreshStatus() {
  let mode = "idle";
  let text = "停止中";
  if (state.running) {
    if (state.speaking && state.talking) [mode, text] = ["speaking", "🔊 しゃべっています"];
    else if (state.speaking) [mode, text] = ["thinking", "🎙 声を準備中…"];
    else if (state.busy) [mode, text] = ["thinking", "🤔 考え中…"];
    else [mode, text] = ["listening", "🎤 聞き取り中"];
  }
  const node = $("#status");
  node.textContent = text;
  node.dataset.kind = mode;
  $("#stage").dataset.mode = mode;
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
  if (kind === "error") stageAlert(text);
}

function refreshPromptPreview() {
  $("#prompt-preview").textContent = buildSystemPrompt(settings);
}

// 吹き出し：声に合わせて1文字ずつ出す。終わったら全文を薄く残して、あとから読めるようにする
let typeTimer = null;
function showBubble(text) {
  clearInterval(typeTimer);
  const node = $("#bubble");
  node.classList.remove("dim");
  node.textContent = "";
  let i = 0;
  typeTimer = setInterval(() => {
    node.textContent = text.slice(0, ++i);
    if (i >= text.length) clearInterval(typeTimer);
  }, 110);
}
function settleBubble(text) {
  clearInterval(typeTimer);
  const node = $("#bubble");
  node.textContent = text;
  node.classList.add("dim");
}

// 画面が消えると聞き取りも止まるので、進行中は消灯させない
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on) wakeLock = await navigator.wakeLock?.request("screen");
    else {
      await wakeLock?.release();
      wakeLock = null;
    }
  } catch {
    // 非対応・拒否でも進行には影響しない
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.running) keepAwake(true);
});

// ---- 聞き取り ----
let captionTimer = null;
const listener = new Listener({
  onFinal(text) {
    if (state.speaking) return;
    state.lastVoiceAt = Date.now();
    state.heard.push({ at: state.lastVoiceAt, text });
    if (state.heard.length > 300) state.heard.shift();
    log("heard", text);
    // 聞き間違いもネタなので、聞き取った内容を字幕のように少しの間見せる
    $("#interim").textContent = `👂 ${text}`;
    clearTimeout(captionTimer);
    captionTimer = setTimeout(() => ($("#interim").textContent = ""), 8000);
  },
  onInterim(text) {
    if (!text || state.speaking) return;
    clearTimeout(captionTimer);
    $("#interim").textContent = `👂 ${text}`;
    state.lastVoiceAt = Date.now();
  },
  onState(s) {
    if (s.startsWith("error:")) log("error", `音声認識: ${s.slice(6)}`);
    // マイクが使えないまま進行すると「聞いていないのにしゃべる」状態になるので止める
    if (s.includes("許可されていません") && state.running) {
      stop();
      setupMessage("マイクが許可されていません。アドレスバー左のアイコン →「権限」→ マイク を許可してから、もう一度「開始」を押してください。");
      return;
    }
    refreshStatus();
  },
});

// ---- しゃべる ----
function voiceOptions({ tension, laugh = false }) {
  const a = settings.audio;
  const f = browserVoiceFactor(tension); // ブラウザの声では速さと高さでテンションを表す
  return {
    engine: a.engine,
    voice: a.openaiVoice,
    instructions: ttsInstructions(settings, { tension, laugh }),
    passcode: passcode(),
    voiceURI: a.voiceURI,
    rate: a.rate * f.rate,
    pitch: a.pitch * f.pitch,
    onFallback: (err) => log("error", `OpenAIの声が使えないのでブラウザの声で代用します: ${err.message}`),
  };
}

async function say(text, reason, { tension, laugh, names }) {
  state.speaking = true;
  state.tension = tension;
  state.lastTargets = names; // 絡んだ人。次の抽選で1回休みにする
  renderTension();
  listener.pause();
  refreshStatus();
  log("ai", text, reason);
  state.aiHistory.push({ at: Date.now(), text });
  if (state.aiHistory.length > 8) state.aiHistory.shift();

  await speak(text, {
    ...voiceOptions({ tension, laugh }),
    onStart: () => {
      state.talking = true;
      showBubble(text);
      refreshStatus();
    },
  });
  settleBubble(text);
  // 残響を拾わないよう少し待ってから聞き取りを再開
  await new Promise((r) => setTimeout(r, 600));

  state.speaking = false;
  state.talking = false;
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
  const cfg = settings.tension;
  const target = targetTension(cfg, now - state.startedAt, state.tension);
  // 頻度の設定にもとづく抽選：今回絡む相手とネタ、笑いを入れるか
  const targets = drawTargets(settings.participants.list, { lastNames: state.lastTargets });
  const laughOn = drawLaugh(settings.laugh.level);

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
          tension: { level: target, label: tensionInfo(target).label, ai: cfg.mode === "ai" },
          laugh: { on: laughOn, ...laughInfo(settings.laugh.level) },
          targets,
        }),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    if (!state.running) return;
    // 読み上げが終わるまで busy のままにして、発話が重ならないようにする
    if (data.speak && data.utterance.trim()) {
      // AIおまかせのときだけAIが選んだ値を使う。それ以外は指示したレベルで声を演じさせる
      const level = cfg.mode === "ai" ? clampLevel(data.tension) : target;
      await say(data.utterance.trim(), data.reason, { tension: level, laugh: laughOn, names: targets.map((t) => t.name) });
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
    setupMessage("先に「合言葉」を入力してください。");
    $("#passcode").focus();
    return;
  }
  if (!isRecognitionSupported) {
    setupMessage("このブラウザは音声認識に対応していません。Chrome か Edge を使ってください。");
    return;
  }
  setupMessage("");
  state.running = true;
  state.startedAt = state.lastCheckAt = state.lastVoiceAt = Date.now();
  state.tension = null;
  unlockAudio(); // 開始ボタンを押した今のうちに、あとからの自動再生を許可してもらう
  keepAwake(true);
  $("#next").disabled = false;
  $("#bubble").textContent = "みなさんの会話を聞いています…";
  $("#bubble").classList.add("dim");
  $("#interim").textContent = "";
  $("#stage-alert").hidden = true;
  updateView();
  listener.start();
  log("system", "開始しました");
  check("start");
}

function stop() {
  state.running = false;
  state.pendingNext = false;
  state.speaking = state.talking = false;
  listener.stop();
  stopSpeaking();
  clearInterval(typeTimer);
  keepAwake(false);
  $("#next").disabled = true;
  log("system", "停止しました");
  updateView();
  refreshStatus();
}

$("#start").addEventListener("click", start);
$("#stop").addEventListener("click", stop);
$("#open-settings").addEventListener("click", () => updateView({ settingsOpen: true }));
$("#close-settings").addEventListener("click", () => updateView());
$("#next").addEventListener("click", () => {
  if (!state.running) return;
  log("system", "幹事が「次へ」を押しました");
  // しゃべり中なら打ち切る。読み上げ完了後に pendingNext として処理される
  if (state.speaking) stopSpeaking();
  check("next");
});

// 笑いのテストボタンは設定画面の描画時に作られる（描画し直しもある）ので、親で受ける
$("#settings").addEventListener("click", (e) => {
  if (!e.target.closest("#laugh-test")) return;
  unlockAudio();
  speak("あはははは！ちょっと待って、ふふっ、おもしろすぎるでしょ！あーっはっはっは！", voiceOptions({ tension: Math.max(3, settings.tension.base), laugh: true }));
});

$("#tension-down").addEventListener("click", () => adjustTension(-1));
$("#tension-up").addEventListener("click", () => adjustTension(1));

$("#voice-test").addEventListener("click", () => {
  unlockAudio();
  const { firstPerson, ending } = settings.speech;
  speak(`${firstPerson || "わたし"}が今日の司会です。よろしくお願いします${ending ? `、${ending.replace(/^〜/, "")}` : ""}。`, voiceOptions({ tension: settings.tension.base }));
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
renderSettings($("#settings"), settings, onSettingsChange);
refreshPromptPreview();
refreshStatus();
updateView();
if (!isRecognitionSupported) setupMessage("このブラウザは音声認識に対応していません。Chrome か Edge を使ってください。");
