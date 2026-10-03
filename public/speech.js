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

// 読み上げ。終わったら resolve する。
export function speak(text, { voiceURI, rate = 1, pitch = 1 } = {}) {
  return new Promise((resolve) => {
    speechSynthesis.cancel();
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
    speak.current = utter;
    speechSynthesis.speak(utter);
  });
}
