// プレゼン進行モード。
//   ① プレゼン中   … 司会は話さず、聞き取るだけ。「プレゼン終了」で次へ
//   ② 送信前の確認 … 書き起こしのNGワードを置換/削除し、直してから「送信」
//   ③ 質問中       … 質問を2〜3つ（種類は質問ごとに選べる）。答えが終わったら次の質問へ
//   ④ 指名         … 質問者を2〜3人、全体で偏らないように名指しして、司会の役割はいったん終わり
import { loadSettings, saveSettings, renderSettings, characterView } from "./settings.js";
import { targetTension, tensionInfo, clampLevel } from "./tension.js";
import { drawLaugh, laughInfo } from "./laugh.js";
import { Listener, speak, stopSpeaking, unlockAudio, isRecognitionSupported } from "./speech.js";
import { buildPresentSystemPrompt, buildQuestionMessage, buildNominateMessage } from "./prompt.js";
import { QUESTION_MODES, defaultFlags, applyNg, mergeHits, pickNominees } from "./present.js";
import { $, passcode, bindPasscodeInput, decide, createWakeLock, createBubble, createLogger, createVoiceOptions } from "./common.js";
import { renderTransfer } from "./transfer.js";

const settings = loadSettings();
const log = createLogger();
const voiceOptions = createVoiceOptions(settings, log);
const bubble = createBubble($("#bubble"));

// ---- 全体を通して覚えておくこと（指名回数・発表済み）。書き起こしは保存しない ----
const STORE_KEY = "facilitator-present-v1";
function loadStore() {
  try {
    return { counts: {}, done: [], ...JSON.parse(localStorage.getItem(STORE_KEY) || "{}") };
  } catch {
    return { counts: {}, done: [] };
  }
}
const store = loadStore();
function saveStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    // 保存できなくても進行は続ける
  }
}

const state = {
  phase: "idle", // idle | presenting | reviewing | asking | nominating | done
  runId: 0, // 中止したら進めて、途中の処理の続きを止める
  presenter: "",
  openedAt: Date.now(), // テンションの「だんだん盛り上げる」の起点
  presentStartedAt: 0,
  chunks: [], // プレゼン中に聞き取った断片
  text: "", // AIに送る書き起こし（NGワード置換済み）
  hits: [], // NGワードの置換結果の累計
  config: { total: 3, flags: [], nominees: 2 },
  qIndex: 0,
  qa: [], // { q, a }
  waiting: null, // 答えを待っている間 { since, heardAny, lastVoiceAt }
  answerBuf: [],
  skipWait: false,
  busy: false,
  speaking: false,
  talking: false,
  sayToken: 0,
  tension: null,
  retry: null,
  hiddenMs: 0, // プレゼン中に、この画面が隠れていた時間の合計
  stalledMs: 0, // プレゼン中に、スリープなどで動作が止まっていた時間の合計
};


// 画面（ライブ表示・字幕・ログ）に出す文字にもNGワードを当てる。会場から画面が見えても、社外秘が映らないように
const mask = (text) => applyNg(text, settings.ngwords.list).text;

const names = () => [...new Set(settings.participants.list.map((p) => p.name.trim()).filter(Boolean))];
const keepAwake = createWakeLock(
  () => state.phase !== "idle",
  (ok) => (ok ? log("system", "🔒 画面が自動で消えないようにしています（PCの電源設定は、念のため確認してください）") : log("error", "⚠ この環境では、画面の自動オフ（スリープ）を防げていません。PCの電源設定で、スリープと画面オフを「なし」にしてください。")),
);

// ---- 画面 ----
const PHASE_SECTIONS = {
  presenting: "#phase-presenting",
  reviewing: "#phase-review",
  asking: "#phase-asking",
  nominating: "#phase-asking",
  done: "#phase-done",
};

function showView({ settingsOpen = false } = {}) {
  const inRun = state.phase !== "idle";
  $("#prep-view").hidden = inRun;
  $("#stage").hidden = !inRun;
  $("#setup-view").hidden = !settingsOpen;
  window.scrollTo(0, 0);
}

function setPhase(phase) {
  state.phase = phase;
  $("#stage").dataset.phase = phase;
  for (const sel of new Set(Object.values(PHASE_SECTIONS))) $(sel).hidden = true;
  if (PHASE_SECTIONS[phase]) $(PHASE_SECTIONS[phase]).hidden = false;
  showView();
  refreshStatus();
  renderFocus();
}

function prepMessage(text) {
  const node = $("#prep-msg");
  node.textContent = text;
  node.hidden = !text;
}

function renderCharacter() {
  const { icon, name } = characterView(settings);
  $("#avatar").textContent = icon;
  $("#char-name").textContent = name;
  $("#event-name").textContent = settings.event.name;
}

function renderFocus() {
  const { presenter, qIndex, config } = state;
  const text = {
    presenting: `🎤 ${presenter}さんのプレゼン中`,
    reviewing: `📝 ${presenter}さんのプレゼン（送信前の確認）`,
    asking: `💬 ${presenter}さんへ 質問 ${qIndex + 1}/${config.total}［${QUESTION_MODES[config.flags[qIndex]]?.label ?? ""}］`,
    nominating: "🙋 質問者を指名中",
    done: "",
  }[state.phase];
  $("#focus-text").textContent = text ?? "";
  $("#q-progress").textContent = text ?? "";
}

function refreshStatus() {
  let mode = "idle";
  let text = "待機中";
  switch (state.phase) {
    case "presenting":
      [mode, text] = ["listening", "🎤 プレゼン聞き取り中"];
      break;
    case "reviewing":
      text = "📝 送信前の確認";
      break;
    case "asking":
    case "nominating":
      if (state.speaking && state.talking) [mode, text] = ["speaking", "🔊 しゃべっています"];
      else if (state.speaking) [mode, text] = ["thinking", "🎙 声を準備中…"];
      else if (state.busy) [mode, text] = ["thinking", "🤔 考え中…"];
      else if (state.waiting) [mode, text] = ["listening", "🎤 答えを聞いています"];
      else [mode, text] = ["thinking", "…"];
      break;
    case "done":
      text = "✅ 質問者を指名しました";
      break;
  }
  const node = $("#status");
  node.textContent = text;
  node.dataset.kind = mode;
  $("#stage").dataset.mode = mode;
  $("#next").disabled = !(state.phase === "asking" && (state.waiting || state.speaking));
}

function refreshPromptPreview() {
  $("#prompt-preview").textContent = buildPresentSystemPrompt(settings);
}

function fail(message, retry) {
  log("error", message);
  state.retry = retry;
  $("#retry").hidden = !retry;
}

// ---- 準備画面 ----
function renderPrep() {
  const list = names();
  const select = $("#presenter");
  const prev = select.value;
  select.replaceChildren(
    new Option("選んでください", ""),
    ...list.map((n) => new Option(`${n}${store.done.includes(n) ? "（発表済）" : ""}`, n)),
  );
  if (list.includes(prev)) select.value = prev;

  const ul = $("#counts");
  ul.replaceChildren();
  if (!list.length) {
    const li = document.createElement("li");
    li.textContent = "設定の「参加者」に名前を登録してください。";
    ul.append(li);
  }
  for (const n of list) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = `${n}${store.done.includes(n) ? "（発表済）" : ""}`;
    const count = document.createElement("span");
    count.textContent = `${store.counts[n] ?? 0}回`;
    if (store.done.includes(n)) li.className = "done";
    li.append(name, count);
    ul.append(li);
  }
}

// ---- ① プレゼン中 ----
function startPresent() {
  const presenter = $("#presenter").value;
  if (!presenter) return prepMessage("発表者を選んでください。（設定の「参加者」に名前を登録すると選べます）");
  if (!passcode()) {
    prepMessage("先に設定で「合言葉」を入力してください。");
    showView({ settingsOpen: true });
    $("#passcode").focus();
    return;
  }
  if (!isRecognitionSupported) return prepMessage("このブラウザは音声認識に対応していません。Chrome か Edge を使ってください。");
  prepMessage("");

  Object.assign(state, { presenter, chunks: [], text: "", hits: [], qa: [], qIndex: 0, waiting: null, answerBuf: [], skipWait: false, tension: null, retry: null, hiddenMs: 0, stalledMs: 0 });
  state.runId++;
  state.presentStartedAt = Date.now();
  unlockAudio(); // 開始ボタンを押した今のうちに、あとからの自動再生を許可してもらう
  keepAwake(true);
  renderCharacter();
  $("#live-transcript").textContent = "";
  $("#interim").textContent = "";
  $("#stage-alert").hidden = true;
  $("#retry").hidden = true;
  bubble.settle(`${presenter}さんのプレゼンを聞いています。終わったら「プレゼン終了」を押してください。`);
  setPhase("presenting");
  listener.start();
  log("system", `${presenter}さんのプレゼンを開始しました`);
}

function renderLive() {
  const box = $("#live-transcript");
  box.textContent = mask(state.chunks.join("\n"));
  box.scrollTop = box.scrollHeight;
}

const fmtElapsed = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

// ---- ② 送信前の確認 ----
function finishPresent() {
  listener.stop();
  $("#interim").textContent = "";
  const r = applyNg(state.chunks.join("\n"), settings.ngwords.list);
  $("#review-text").value = r.text;
  state.hits = r.hits;
  const total = settings.presentation.questions;
  state.config = { total, flags: defaultFlags(total), nominees: settings.presentation.nominees };
  renderConfig();
  renderHits();
  hiddenNote();
  setPhase("reviewing");
  log("system", `プレゼン終了（${state.chunks.length}件の聞き取り）${r.total ? `。NGワードを${r.total}件置き換えました` : ""}`);
}

// 確認画面に、プレゼン中に画面が隠れていた時間を出す（その間の書き起こしが欠けている可能性）
function hiddenNote() {
  const node = $("#hidden-note");
  const hidden = Math.round(state.hiddenMs / 1000);
  const stalled = Math.round(state.stalledMs / 1000);
  const parts = [];
  if (hidden) parts.push(`この画面が合計約${hidden}秒間、隠れていました`);
  if (stalled) parts.push(`PCのスリープなどで、合計約${stalled}秒間、動作が止まっていた可能性があります`);
  node.textContent = parts.length ? `⚠ プレゼン中に、${parts.join("。また、")}。その間の聞き取りが欠けている可能性があります。必要なら、下の欄で補ってください。` : "";
  node.hidden = !parts.length;
}

function renderHits() {
  const box = $("#ng-summary");
  box.replaceChildren();
  if (!state.hits.length) {
    const none = document.createElement("span");
    none.className = "none";
    none.textContent = "NGワードは見つかりませんでした。";
    box.append(none);
    return;
  }
  const total = state.hits.reduce((n, h) => n + h.count, 0);
  const head = document.createElement("div");
  head.textContent = `NGワードを置き換えました（計${total}件）`;
  const ul = document.createElement("ul");
  for (const h of state.hits) {
    const li = document.createElement("li");
    li.textContent = `「${h.word}」→ ${h.to ? `「${h.to}」` : "（削除）"} ×${h.count}`;
    ul.append(li);
  }
  box.append(head, ul);
}

// 書き起こしにNGワードを当てて置換する。結果は累計に足す
function recheck() {
  const r = applyNg($("#review-text").value, settings.ngwords.list);
  $("#review-text").value = r.text;
  state.hits = mergeHits(state.hits, r.hits);
  renderHits();
  return r;
}

function addNg() {
  const word = $("#ng-word").value.trim();
  if (!word) return $("#ng-word").focus();
  settings.ngwords.list.push({ word, to: $("#ng-to").value.trim() });
  saveSettings(settings);
  renderSettings($("#settings"), settings, onSettingsChange, "present");
  $("#ng-word").value = $("#ng-to").value = "";
  const r = recheck();
  log("system", `NGワード「${word}」を追加し、${r.total}件を置き換えました`);
}

function renderConfig() {
  const { total, flags, nominees } = state.config;
  $("#q-count").value = String(total);
  $("#nom-count").value = String(nominees);
  const box = $("#q-flags");
  box.replaceChildren();
  flags.forEach((flag, i) => {
    const label = document.createElement("label");
    label.className = "field";
    const span = document.createElement("span");
    span.textContent = `質問${i + 1}${i === total - 1 ? "（最後）" : ""}の種類`;
    const select = document.createElement("select");
    for (const [key, m] of Object.entries(QUESTION_MODES)) select.append(new Option(`${m.icon} ${m.label}`, key, false, key === flag));
    select.addEventListener("change", () => (state.config.flags[i] = select.value));
    label.append(span, select);
    box.append(label);
  });
}

function send() {
  // 念のため、送る直前にもNGワードを当てる。残っていたら、置き換えた結果を見てもらってから送る
  const r = recheck();
  if (r.total > 0) {
    log("error", `NGワードが${r.total}件残っていたので置き換えました。内容を確認して、もう一度「送信」を押してください。`);
    return;
  }
  const text = $("#review-text").value.trim();
  if (!text) return log("error", "書き起こしが空です。録音を再開するか、直接入力してください。");
  state.text = text;
  state.qa = [];
  listener.start(); // 質問への答えを聞き取る
  runQuestion(0);
}

function resumeRecording() {
  state.chunks = [$("#review-text").value]; // 手直しした内容を土台に、続きを足す
  renderLive();
  bubble.settle(`${state.presenter}さんのプレゼンを聞いています（続き）。終わったら「プレゼン終了」を押してください。`);
  setPhase("presenting");
  listener.start();
}

// ---- しゃべる（1回のセリフ） ----
async function say(text, { tension, laugh }) {
  const token = ++state.sayToken;
  state.speaking = true;
  state.tension = tension;
  listener.pause();
  refreshStatus();
  log("ai", text);
  await speak(text, {
    ...voiceOptions({ tension, laugh }),
    onStart: () => {
      state.talking = true;
      bubble.show(text);
      refreshStatus();
    },
  });
  bubble.settle(text);
  await new Promise((r) => setTimeout(r, 600)); // 残響を拾わないように
  if (token === state.sayToken) {
    state.speaking = false;
    state.talking = false;
    refreshStatus();
  }
}

function cancelSay() {
  state.sayToken++;
  stopSpeaking();
  state.speaking = state.talking = false;
}

// 「じっくり」は発表の内容重視：笑い声は入れず、テンションは基本のレベルで一定にする。「にぎやか」は飲み会と同じ設定を使う
const isLively = () => settings.presentation.style === "lively";
const drawTurn = () => ({
  level: isLively() ? targetTension(settings.tension, Date.now() - state.openedAt, state.tension) : clampLevel(settings.tension.base),
  laugh: isLively() && drawLaugh(settings.laugh.level),
});
const aiDecidesTension = () => isLively() && settings.tension.mode === "ai";
const tensionInfoFor = (level) => ({ level, label: tensionInfo(level).label, ai: aiDecidesTension() });

// ---- ③ 質問中 ----
async function runQuestion(i) {
  const runId = state.runId;
  state.qIndex = i;
  state.retry = null;
  $("#retry").hidden = true;
  setPhase("asking");

  const { level, laugh } = drawTurn();
  state.busy = true;
  refreshStatus();
  let data;
  try {
    data = await decide(
      buildPresentSystemPrompt(settings),
      buildQuestionMessage({
        presenter: state.presenter,
        transcript: state.text,
        qa: state.qa,
        index: i,
        total: state.config.total,
        mode: state.config.flags[i],
        tension: tensionInfoFor(level),
        laugh: { on: laugh, ...laughInfo(settings.laugh.level) },
        now: Date.now(),
      }),
    );
  } catch (err) {
    if (runId === state.runId) fail(`AI判断に失敗: ${err.message}`, () => runQuestion(i));
    return;
  } finally {
    state.busy = false;
    if (runId === state.runId) refreshStatus();
  }
  if (runId !== state.runId) return;

  const utterance = (data.utterance ?? "").trim();
  if (!utterance) return fail("AIが質問を返しませんでした", () => runQuestion(i));
  state.qa.push({ q: utterance, a: "" });
  await say(utterance, { tension: aiDecidesTension() ? clampLevel(data.tension) : level, laugh });
  if (runId !== state.runId) return;
  startAnswerWait();
}

function startAnswerWait() {
  if (state.skipWait) {
    state.skipWait = false;
    return finishAnswer();
  }
  const now = Date.now();
  state.answerBuf = [];
  state.waiting = { since: now, heardAny: false, lastVoiceAt: now };
  listener.resume();
  refreshStatus();
}

function finishAnswer() {
  if (state.phase !== "asking") return;
  state.waiting = null;
  listener.pause();
  // 答えもAIに送るので、NGワードを自動で当てる
  const answer = applyNg(state.answerBuf.join("\n"), settings.ngwords.list).text;
  if (state.qa.length) state.qa[state.qa.length - 1].a = answer;
  state.answerBuf = [];
  $("#interim").textContent = "";
  refreshStatus();
  if (state.qIndex + 1 < state.config.total) runQuestion(state.qIndex + 1);
  else nominate();
}

// ---- ④ 質問者の指名。名指ししたら、司会の役割はそこで終わり ----
async function nominate() {
  const runId = state.runId;
  state.retry = null;
  $("#retry").hidden = true;
  setPhase("nominating");

  const nominees = pickNominees(names(), store.counts, state.presenter, state.config.nominees);
  if (!nominees.length) {
    log("error", "指名できる参加者がいません。設定の「参加者」に、発表者以外の名前を登録してください。");
    return finishPresentation([]);
  }
  const { level, laugh } = drawTurn();
  state.busy = true;
  refreshStatus();
  let text = "";
  try {
    const data = await decide(
      buildPresentSystemPrompt(settings),
      buildNominateMessage({
        presenter: state.presenter,
        nominees,
        tension: tensionInfoFor(level),
        laugh: { on: laugh, ...laughInfo(settings.laugh.level) },
        now: Date.now(),
      }),
    );
    text = (data.utterance ?? "").trim();
  } catch (err) {
    if (runId === state.runId) fail(`AI判断に失敗: ${err.message}`, () => nominate());
    return;
  } finally {
    state.busy = false;
    if (runId === state.runId) refreshStatus();
  }
  if (runId !== state.runId) return;
  // 名前が抜けていたら、確実に伝わる定型の言い方にする
  if (!nominees.every((n) => text.includes(n))) {
    text = `${state.presenter}さん、ありがとうございました！それでは、${nominees.map((n) => `${n}さん`).join("、")}、質問をお願いします！`;
  }
  await say(text, { tension: level, laugh });
  if (runId !== state.runId) return;

  for (const n of nominees) store.counts[n] = (store.counts[n] ?? 0) + 1;
  if (!store.done.includes(state.presenter)) store.done.push(state.presenter);
  saveStore();
  finishPresentation(nominees);
}

function finishPresentation(nominees) {
  listener.stop();
  keepAwake(false);
  $("#nominees").textContent = nominees.map((n) => `${n}さん`).join("、") || "（なし）";
  setPhase("done");
  log("system", `質問者を指名しました：${nominees.join("、") || "なし"}`);
}

// ---- 中止・次のプレゼンへ ----
function toIdle(message) {
  state.runId++;
  cancelSay();
  listener.stop();
  keepAwake(false);
  bubble.stop();
  Object.assign(state, { waiting: null, busy: false, retry: null, skipWait: false });
  $("#retry").hidden = true;
  renderPrep();
  setPhase("idle");
  if (message) log("system", message);
}

function abort() {
  if (state.phase === "idle") return;
  if (["presenting", "reviewing"].includes(state.phase) && !confirm("書き起こしは破棄されます。中止しますか？")) return;
  toIdle("中止しました");
}

// ---- 聞き取り ----
let captionTimer = null;
function caption(text) {
  clearTimeout(captionTimer);
  $("#interim").textContent = text ? `👂 ${mask(text)}` : "";
  if (text) captionTimer = setTimeout(() => ($("#interim").textContent = ""), 8000);
}

function handleVoice(text) {
  const now = Date.now();
  if (state.phase === "presenting") {
    state.chunks.push(text);
    renderLive();
    $("#interim").textContent = "";
  } else if (state.phase === "asking" && state.waiting) {
    state.answerBuf.push(text);
    state.waiting.heardAny = true;
    state.waiting.lastVoiceAt = now;
    caption(text);
  } else {
    return;
  }
  log("heard", mask(text));
}

const listener = new Listener({
  onFinal(text) {
    if (!state.speaking) handleVoice(text);
  },
  onInterim(text) {
    if (!text || state.speaking) return;
    if (state.phase === "presenting") $("#interim").textContent = `👂 ${mask(text)}`;
    else if (state.phase === "asking" && state.waiting) {
      state.waiting.heardAny = true;
      state.waiting.lastVoiceAt = Date.now();
      caption(text);
    }
  },
  onStalled(ms) {
    if (state.phase === "presenting") state.stalledMs += ms;
    log("error", `PCのスリープなどで、約${Math.round(ms / 1000)}秒間、動作が止まっていた可能性があります。その間の聞き取りは欠けています。`);
  },
  onHidden(ms) {
    if (state.phase === "presenting") state.hiddenMs += ms;
    log("error", `この画面が約${Math.round(ms / 1000)}秒間、他のウィンドウの裏に隠れていました。その間の聞き取りが欠けている可能性があります（隠れると、Chromeが動きを抑えることがあります）。`);
  },
  onState(s) {
    if (s.startsWith("error:")) log("error", `音声認識: ${s.slice(6)}`);
    if (s.includes("許可されていません") && state.phase !== "idle") {
      toIdle();
      prepMessage("マイクが許可されていません。アドレスバー左のアイコン →「権限」→ マイク を許可してから、もう一度やり直してください。");
      return;
    }
    refreshStatus();
  },
});

// 1秒ごとに、経過時間の表示と「答えが終わったか」の判定
setInterval(() => {
  if (state.phase === "presenting") $("#elapsed").textContent = fmtElapsed(Date.now() - state.presentStartedAt);
  if (state.phase === "asking" && state.waiting && !state.busy && !state.speaking) {
    const w = state.waiting;
    const now = Date.now();
    const { answerSilenceSec, answerMaxWaitSec } = settings.presentation;
    if (w.heardAny && now - w.lastVoiceAt >= answerSilenceSec * 1000) finishAnswer();
    else if (!w.heardAny && now - w.since >= answerMaxWaitSec * 1000) finishAnswer();
  }
}, 1000);

// ---- ボタン ----
function onSettingsChange() {
  refreshPromptPreview();
  renderPrep();
  if (state.phase !== "idle") renderCharacter();
}

$("#start-present").addEventListener("click", startPresent);
$("#finish-present").addEventListener("click", finishPresent);
$("#abort").addEventListener("click", abort);
$("#send").addEventListener("click", send);
$("#resume-rec").addEventListener("click", resumeRecording);
$("#discard").addEventListener("click", () => {
  if (confirm("書き起こしを破棄して、準備画面に戻ります。よろしいですか？")) toIdle("書き起こしを破棄しました");
});
$("#ng-add").addEventListener("click", addNg);
$("#ng-recheck").addEventListener("click", () => {
  const r = recheck();
  log("system", r.total ? `NGワードを${r.total}件置き換えました` : "NGワードは見つかりませんでした");
});
$("#q-count").addEventListener("change", (e) => {
  const total = Number(e.target.value);
  state.config.total = total;
  state.config.flags = defaultFlags(total);
  renderConfig();
});
$("#nom-count").addEventListener("change", (e) => (state.config.nominees = Number(e.target.value)));
$("#next").addEventListener("click", () => {
  if (state.phase !== "asking") return;
  log("system", "幹事が「次へ」を押しました");
  if (state.waiting) finishAnswer();
  else if (state.speaking) {
    state.skipWait = true;
    cancelSay();
  }
});
$("#retry").addEventListener("click", () => {
  const retry = state.retry;
  state.retry = null;
  $("#retry").hidden = true;
  retry?.();
});
$("#next-presenter").addEventListener("click", () => toIdle());
$("#reset-counts").addEventListener("click", () => {
  if (!confirm("指名回数と発表済みの記録をリセットします。よろしいですか？")) return;
  store.counts = {};
  store.done = [];
  saveStore();
  renderPrep();
});
$("#open-settings").addEventListener("click", () => showView({ settingsOpen: true }));
$("#open-settings-prep").addEventListener("click", () => showView({ settingsOpen: true }));
$("#close-settings").addEventListener("click", () => {
  showView();
  if (state.phase !== "idle") renderCharacter();
});
$("#voice-test").addEventListener("click", () => {
  unlockAudio();
  const { firstPerson, ending } = settings.speech;
  speak(`${firstPerson || "わたし"}が今日の司会です。よろしくお願いします${ending ? `、${ending.replace(/^〜/, "")}` : ""}。`, voiceOptions({ tension: settings.tension.base }));
});

// 手入力で「聞き取った」ことにする（マイクなしでの動作確認用）
$("#manual").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("#manual-text").value.trim();
  if (!text) return;
  handleVoice(text);
  $("#manual-text").value = "";
});

// 発表の途中で誤ってページを閉じて、書き起こしを失わないように
window.addEventListener("beforeunload", (e) => {
  if (["presenting", "reviewing"].includes(state.phase)) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// ---- 初期化 ----
try {
  localStorage.removeItem("facilitator-materials-v1"); // 以前の「資料」機能が残した保存データ
} catch {
  // 消せなくても影響はない
}
renderTransfer($("#transfer"), settings);
bindPasscodeInput();
renderSettings($("#settings"), settings, onSettingsChange, "present");
refreshPromptPreview();
renderPrep();
setPhase("idle");
if (!isRecognitionSupported) prepMessage("このブラウザは音声認識に対応していません。Chrome か Edge を使ってください。");
