// 音声認識（常時聞き取り・自動再起動）と読み上げ。
// 読み上げ中は認識を止めて、自分の声を拾って暴走するのを防ぐ。

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export const isRecognitionSupported = Boolean(Recognition);

export class Listener {
  /**
   * @param {object} handlers
   * @param {(text:string)=>void} handlers.onFinal    確定した聞き取り
   * @param {(text:string)=>void} [handlers.onInterim] 途中経過
   * @param {(state:string)=>void} [handlers.onState] "listening" | "paused" | "stopped" | "error:..."
   */
  constructor(handlers) {
    this.handlers = handlers;
    this.wanted = false; // 聞き取りを続けたいか（ユーザーが開始した状態）
    this.paused = false; // 読み上げ中などで一時停止中か
    this.running = false; // 認識エンジンが実際に動いているか
    this.restartDelay = 300;
    this.restartTimer = null;
    this.hiddenSince = null;
    this.lastBeat = Date.now();
    // 画面が表示されているのに、1秒ごとの見張りが大きく空いたら、PCのスリープなどで止まっていた。戻ったら立て直す
    setInterval(() => {
      const now = Date.now();
      const gap = now - this.lastBeat;
      this.lastBeat = now;
      if (this.wanted && gap > 8000 && document.visibilityState === "visible") {
        if (!this.paused && !this.running) {
          clearTimeout(this.restartTimer);
          this.restartDelay = 300;
          this.#launch();
        }
        this.handlers.onStalled?.(gap);
      }
    }, 1000);
    // 画面が他のウィンドウ（パワポなど）の裏に隠れると、Chromeは動きを抑える。隠れていた時間を知らせ、戻ったらすぐ聞き取りを立て直す
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        this.hiddenSince = this.wanted ? Date.now() : null;
      } else {
        this.lastBeat = Date.now(); // 隠れていた間の空白は、下の「隠れていた」の知らせで扱う（二重に知らせない）
      }
      if (document.visibilityState === "visible" && this.hiddenSince) {
        const ms = Date.now() - this.hiddenSince;
        this.hiddenSince = null;
        if (this.wanted && !this.paused && !this.running) {
          clearTimeout(this.restartTimer);
          this.restartDelay = 300;
          this.#launch();
        }
        if (this.wanted && ms >= 5000) this.handlers.onHidden?.(ms);
      }
    });
  }

  start() {
    this.wanted = true;
    this.paused = false;
    this.#launch();
  }

  stop() {
    this.wanted = false;
    this.#halt();
    this.handlers.onState?.("stopped");
  }

  pause() {
    this.paused = true;
    this.#halt();
    this.handlers.onState?.("paused");
  }

  resume() {
    if (!this.wanted) return;
    this.paused = false;
    this.#launch();
  }

  #halt() {
    clearTimeout(this.restartTimer);
    if (this.rec) {
      // abort は聞きかけの結果を捨てる。自分の声の断片を拾わないためにこちらを使う。
      this.rec.onresult = null;
      this.rec.abort();
    }
  }

  #launch() {
    if (!isRecognitionSupported || this.running) return;
    const rec = new Recognition();
    rec.lang = "ja-JP";
    rec.continuous = true;
    rec.interimResults = true;

    rec.onstart = () => {
      this.running = true;
      this.handlers.onState?.("listening");
    };

    rec.onresult = (event) => {
      if (this.paused) return;
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript.trim();
        if (!text) continue;
        if (result.isFinal) {
          this.handlers.onFinal(text);
          this.restartDelay = 300; // 正常に聞き取れたらバックオフをリセット
        } else {
          interim += text;
        }
      }
      this.handlers.onInterim?.(interim);
    };

    rec.onerror = (event) => {
      // no-speech / aborted は日常的に起きるので無視して再起動に任せる
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        this.wanted = false;
        this.handlers.onState?.("error:マイクの使用が許可されていません");
      } else if (event.error !== "no-speech" && event.error !== "aborted") {
        this.handlers.onState?.(`error:${event.error}`);
      }
    };

    // ブラウザの音声認識は勝手に止まるので、続けたい間は自動で立ち上げ直す
    rec.onend = () => {
      this.running = false;
      this.handlers.onInterim?.("");
      if (this.wanted && !this.paused) {
        this.restartTimer = setTimeout(() => this.#launch(), this.restartDelay);
        // 即座に落ち続ける場合に備えて、少しずつ間隔を空ける（最大5秒）
        this.restartDelay = Math.min(this.restartDelay * 1.5, 5000);
      }
    };

    this.rec = rec;
    try {
      rec.start();
    } catch {
      // すでに開始中などの例外は無視（onend で再試行される）
    }
  }
}

// ---- 読み上げ ----
// 声のエンジンは2種類：OpenAIの音声合成(自然・有料) と ブラウザ標準(無料・機械的)。
// OpenAIの声が失敗したら、会が止まらないようブラウザ標準の声で代わりに読む。

const sharedAudio = new Audio(); // 使い回す。スマホでは一度ユーザー操作で再生許可を取る必要がある
let current = null; // 実行中の読み上げ { stop() }
let speakId = 0; // 読み上げの世代。停止したら進めて、古い読み上げが後から鳴らないようにする

// 無音の短いWAV。開始ボタンなどのクリック時に鳴らして、あとからの自動再生を許可してもらう
const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

export function unlockAudio() {
  sharedAudio.src = SILENT_WAV;
  sharedAudio.play().catch(() => {});
}

export function stopSpeaking() {
  speakId++;
  current?.stop();
  speechSynthesis.cancel();
}

/**
 * @param {string} text
 * @param {object} o
 * @param {"openai"|"browser"} [o.engine]
 * @param {string} [o.voice]         OpenAIの声の名前
 * @param {string} [o.instructions]  OpenAIの声への演技指示
 * @param {string} [o.passcode]
 * @param {string} [o.voiceURI] @param {number} [o.rate] @param {number} [o.pitch]  ブラウザの声の設定
 * @param {(err:Error)=>void} [o.onFallback]
 * @param {()=>void} [o.onStart]     声が出始めたとき
 */
export async function speak(text, opts = {}) {
  stopSpeaking();
  const id = speakId;
  // 声が出始める瞬間に1度だけ知らせる（OpenAIの声が失敗してブラウザの声に代わっても重複させない）
  let started = false;
  const o = {
    ...opts,
    onStart: () => {
      if (started) return;
      started = true;
      opts.onStart?.();
    },
  };
  if (o.engine === "openai") {
    try {
      await speakOpenAI(text, o, id);
      return;
    } catch (err) {
      if (id !== speakId) return; // 失敗ではなく、止められただけ
      o.onFallback?.(err);
    }
  }
  await speakBrowser(text, o);
}

async function speakOpenAI(text, { voice, instructions, passcode, onStart }, id) {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Passcode": passcode || "" },
    body: JSON.stringify({ text, voice, instructions }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  if (id !== speakId) return; // 取得中に停止された

  const url = URL.createObjectURL(blob);
  try {
    await new Promise((resolve, reject) => {
      const guard = setTimeout(resolve, 60_000); // 終了イベントが来ない場合の保険
      const finish = (fn) => {
        clearTimeout(guard);
        sharedAudio.onended = sharedAudio.onerror = null;
        current = null;
        fn();
      };
      sharedAudio.onended = () => finish(resolve);
      sharedAudio.onerror = () => finish(() => reject(new Error("音声を再生できませんでした")));
      current = {
        stop() {
          sharedAudio.pause();
          finish(resolve);
        },
      };
      sharedAudio.src = url;
      sharedAudio.play().then(onStart, (err) => finish(() => reject(err)));
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function speakBrowser(text, { voiceURI, rate = 1, pitch = 1, onStart }) {
  return new Promise((resolve) => {
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "ja-JP";
    utter.rate = rate;
    utter.pitch = pitch;
    const voice = speechSynthesis.getVoices().find((v) => v.voiceURI === voiceURI);
    if (voice) utter.voice = voice;

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      resolve();
    };
    utter.onend = finish;
    utter.onerror = finish;
    // Chrome では onend が来ないことがあるので、文字数から見積もった時間で打ち切る
    const guard = setTimeout(finish, (text.length * 250) / rate + 4000);

    // 参照を保持しないとGCされてイベントが来ない不具合への対策
    speakBrowser.current = utter;
    onStart?.();
    speechSynthesis.speak(utter);
  });
}
