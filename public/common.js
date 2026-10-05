// 飲み会モード・プレゼン進行モードの両ページで共通に使う部品。
import { ttsInstructions } from "./settings.js";
import { browserVoiceFactor } from "./tension.js";

export const $ = (sel) => document.querySelector(sel);

// ---- 合言葉：この端末のブラウザにだけ保存する（設定とは別。AIへの指示文には入れない） ----
const PASSCODE_KEY = "facilitator-passcode";

export function passcode() {
  try {
    return localStorage.getItem(PASSCODE_KEY) || "";
  } catch {
    return $("#passcode")?.value ?? "";
  }
}

export function bindPasscodeInput() {
  const input = $("#passcode");
  if (!input) return;
  input.value = passcode();
  input.addEventListener("input", (e) => {
    try {
      localStorage.setItem(PASSCODE_KEY, e.target.value);
    } catch {
      // 保存できなくても、入力欄の値をそのまま使う
    }
  });
}

// ---- AIへの問い合わせ（サーバーの /api/decide） ----
export async function decide(system, user) {
  const res = await fetch("/api/decide", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Passcode": passcode() },
    body: JSON.stringify({ system, user }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---- 画面が消えると聞き取りも止まるので、進行中は消灯させない ----
export function createWakeLock(isActive) {
  let lock = null;
  async function set(on) {
    try {
      if (on) lock = await navigator.wakeLock?.request("screen");
      else {
        await lock?.release();
        lock = null;
      }
    } catch {
      // 非対応・拒否でも進行には影響しない
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && isActive()) set(true);
  });
  return set;
}

// ---- 吹き出し：声に合わせて1文字ずつ出す。終わったら全文を薄く残す ----
export function createBubble(node) {
  let timer = null;
  return {
    show(text) {
      clearInterval(timer);
      node.classList.remove("dim");
      node.textContent = "";
      let i = 0;
      timer = setInterval(() => {
        node.textContent = text.slice(0, ++i);
        if (i >= text.length) clearInterval(timer);
      }, 110);
    },
    settle(text) {
      clearInterval(timer);
      node.textContent = text;
      node.classList.add("dim");
    },
    stop() {
      clearInterval(timer);
    },
  };
}

// ---- ログ表示（#log）と、画面上部の赤い通知（#stage-alert） ----
export function createLogger() {
  let alertTimer = null;
  function stageAlert(text) {
    const node = $("#stage-alert");
    if (!node) return;
    node.textContent = text;
    node.hidden = false;
    clearTimeout(alertTimer);
    alertTimer = setTimeout(() => (node.hidden = true), 12_000);
  }
  return function log(kind, text, note = "") {
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
  };
}

// ---- 読み上げの設定（speak() に渡す） ----
export function createVoiceOptions(settings, log) {
  return function voiceOptions({ tension, laugh = false, segment, perfType }) {
    const a = settings.audio;
    const f = browserVoiceFactor(tension); // ブラウザの声では速さと高さでテンションを表す
    return {
      engine: a.engine,
      voice: a.openaiVoice,
      instructions: ttsInstructions(settings, { tension, laugh, segment, perfType }),
      passcode: passcode(),
      voiceURI: a.voiceURI,
      rate: a.rate * f.rate,
      pitch: a.pitch * f.pitch,
      onFallback: (err) => log("error", `OpenAIの声が使えないのでブラウザの声で代用します: ${err.message}`),
    };
  };
}
