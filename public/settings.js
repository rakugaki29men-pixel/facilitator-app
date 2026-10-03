// 設定項目の登録簿。
// 項目を増やすときは SECTIONS に1つ追加するだけでよい：
//   id       : 保存キー
//   title    : 設定画面の見出し
//   defaults : 初期値
//   render   : (要素, 現在値, 変更通知) => void   設定UIを描画
//   toPrompt : (値) => string | ""              AIへの指示文に入れる文章（不要なら省略）

const STORAGE_KEY = "facilitator-settings-v1";

export const CHARACTER_PRESETS = [
  { id: "kansai", label: "関西の芸人司会", text: "ノリとツッコミが命の関西芸人。ボケを拾ってツッコみ、場を笑いで回す。" },
  { id: "veteran", label: "ベテラン宴会司会", text: "場慣れした落ち着きのある宴会司会。全員に目を配り、さりげなく話を振る。" },
  { id: "jikkyo", label: "熱血スポーツ実況", text: "何でも実況してしまう熱血アナウンサー。会話の盛り上がりを試合のように中継する。" },
  { id: "butler", label: "老執事", text: "丁寧すぎる老執事。皆様をおもてなしするが、ときどき天然な発言をする。" },
  { id: "yuru", label: "ゆるキャラ", text: "ふわっとしたゆるキャラ。のんびりしているが、急に核心を突く。" },
  { id: "none", label: "（なし・自由記述のみ）", text: "" },
];

export const SPEECH_PRESETS = [
  { id: "none", label: "指定なし", firstPerson: "", ending: "", catchphrase: "" },
  { id: "samurai", label: "侍", firstPerson: "拙者", ending: "〜でござる", catchphrase: "かたじけない" },
  { id: "ojousama", label: "お嬢様", firstPerson: "わたくし", ending: "〜ですわ", catchphrase: "おほほほ" },
  { id: "gal", label: "ギャル", firstPerson: "うち", ending: "〜じゃん", catchphrase: "それな〜" },
  { id: "kansai", label: "関西弁", firstPerson: "ワイ", ending: "〜やで", catchphrase: "なんでやねん" },
  { id: "nya", label: "ねこ", firstPerson: "ボク", ending: "〜にゃ", catchphrase: "にゃるほど" },
];

// 声のタイプ。
//  voice/style : OpenAIの声(自然)で使う声の名前と演技指示
//  pitch/rate  : ブラウザ標準の声で使う高さと速さ（声の種類が少ないので、これで雰囲気を作る）
export const VOICE_TYPES = [
  { label: "標準", voice: "coral", style: "明るく親しみやすい司会者の声で。", pitch: 1.0, rate: 1.1 },
  { label: "男性っぽく", voice: "onyx", style: "落ち着いた低めの男性の声で。", pitch: 0.7, rate: 1.0 },
  { label: "女性っぽく", voice: "nova", style: "明るい若い女性の声で。", pitch: 1.25, rate: 1.1 },
  { label: "おじいちゃん", voice: "ash", style: "高齢の男性。ゆっくり、少ししわがれた温かい声で。", pitch: 0.55, rate: 0.8 },
  { label: "おばあちゃん", voice: "shimmer", style: "高齢の女性。ゆっくり、やさしくおっとりした声で。", pitch: 1.35, rate: 0.8 },
  { label: "子ども", voice: "nova", style: "元気な子どもの声で。高めで無邪気に。", pitch: 1.8, rate: 1.2 },
  { label: "早口の実況", voice: "echo", style: "スポーツ実況のように、早口で熱く盛り上げる。", pitch: 1.0, rate: 1.6 },
];

export const OPENAI_VOICES = ["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"];

// ---- 小さなDOMヘルパー ----
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c != null));
  return node;
}

function field(label, input) {
  // ボタンの集まりなどを label で包むと、文字をタップしたとき先頭のボタンが押されてしまう
  const wrapper = ["INPUT", "SELECT", "TEXTAREA"].includes(input.tagName) ? "label" : "div";
  return el(wrapper, { className: "field" }, el("span", {}, label), input);
}

function textInput(value, onInput, placeholder = "") {
  return el("input", { type: "text", value, placeholder, oninput: (e) => onInput(e.target.value) });
}

function textArea(value, onInput, placeholder = "") {
  return el("textarea", { value, placeholder, rows: 3, oninput: (e) => onInput(e.target.value) });
}

// value[key] を書き換えて update(value) を呼ぶ関数を作る
function setter(value, update) {
  return (key) => (v) => {
    value[key] = v;
    update(value);
  };
}

function newId() {
  return Math.random().toString(36).slice(2, 10);
}

// ---- 各セクション ----
export const SECTIONS = [
  {
    id: "event",
    title: "会の情報",
    defaults: { name: "社内懇親会", note: "会議室で約15人。お酒あり。" },
    render(root, value, update) {
      const set = setter(value, update);
      root.append(
        field("会の名前", textInput(value.name, set("name"))),
        field("補足（雰囲気・目的など）", textArea(value.note, set("note"))),
      );
    },
    toPrompt(v) {
      const lines = [];
      if (v.name) lines.push(`会の名前：${v.name}`);
      if (v.note) lines.push(`補足：${v.note}`);
      return lines.length ? `# 会について\n${lines.join("\n")}` : "";
    },
  },

  {
    id: "participants",
    title: "参加者",
    defaults: { list: [] },
    render(root, value, update) {
      const list = el("div", { className: "participant-list" });
      const commit = () => update(value);

      const draw = () => {
        list.replaceChildren();
        if (value.list.length === 0) list.append(el("p", { className: "hint" }, "まだ誰もいません。下から追加してください。"));
        value.list.forEach((p, i) => {
          list.append(
            el(
              "div",
              { className: "participant-row" },
              textInput(p.name, (v) => ((p.name = v), commit()), "名前"),
              textInput(p.memo, (v) => ((p.memo = v), commit()), "ひとことメモ（例：カラオケ好き）"),
              el("button", {
                type: "button",
                className: "icon-btn",
                title: "削除",
                textContent: "✕",
                onclick: () => {
                  value.list.splice(i, 1);
                  commit();
                  draw();
                },
              }),
            ),
          );
        });
      };

      const nameIn = textInput("", () => {}, "名前");
      const memoIn = textInput("", () => {}, "ひとことメモ");
      const add = () => {
        const name = nameIn.value.trim();
        if (!name) return nameIn.focus();
        value.list.push({ id: newId(), name, memo: memoIn.value.trim() });
        nameIn.value = memoIn.value = "";
        commit();
        draw();
        nameIn.focus();
      };
      for (const input of [nameIn, memoIn]) {
        input.addEventListener("keydown", (e) => e.key === "Enter" && !e.isComposing && add());
      }

      draw();
      root.append(
        list,
        el("div", { className: "participant-row add-row" }, nameIn, memoIn,
          el("button", { type: "button", className: "icon-btn add", title: "追加", textContent: "＋", onclick: add })),
      );
    },
    toPrompt(v) {
      const people = v.list.filter((p) => p.name.trim());
      if (!people.length) return "";
      const lines = people.map((p) => `- ${p.name}${p.memo ? `：${p.memo}` : ""}`);
      return `# 参加者（${people.length}人）\n${lines.join("\n")}\n※聞き取った名前が多少違っても、近い名前ならこの人たちのことだと推測してよい。`;
    },
  },

  {
    id: "character",
    title: "司会者のキャラ",
    defaults: { preset: "kansai", custom: "" },
    render(root, value, update) {
      const set = setter(value, update);
      const select = el(
        "select",
        { onchange: (e) => set("preset")(e.target.value) },
        ...CHARACTER_PRESETS.map((p) => el("option", { value: p.id, textContent: p.label, selected: p.id === value.preset })),
      );
      root.append(
        field("プリセット", select),
        field("自由記述（プリセットに追加される）", textArea(value.custom, set("custom"), "例：部長のモノマネが得意。隙あらばダジャレを言う。")),
      );
    },
    toPrompt(v) {
      const preset = CHARACTER_PRESETS.find((p) => p.id === v.preset)?.text || "";
      const text = [preset, v.custom.trim()].filter(Boolean).join("\n");
      return text ? `# あなたのキャラクター\n${text}` : "";
    },
  },

  {
    id: "speech",
    title: "しゃべり方",
    defaults: { firstPerson: "", ending: "", catchphrase: "", extra: "" },
    render(root, value, update) {
      const inputs = {};
      const set = setter(value, update);
      inputs.firstPerson = textInput(value.firstPerson, set("firstPerson"), "例：拙者");
      inputs.ending = textInput(value.ending, set("ending"), "例：〜でござる");
      inputs.catchphrase = textInput(value.catchphrase, set("catchphrase"), "例：かたじけない");

      const presetRow = el("div", { className: "chips" },
        ...SPEECH_PRESETS.map((p) =>
          el("button", {
            type: "button",
            className: "chip",
            textContent: p.label,
            onclick: () => {
              for (const key of ["firstPerson", "ending", "catchphrase"]) {
                value[key] = p[key];
                inputs[key].value = p[key];
              }
              update(value);
            },
          }),
        ),
      );

      root.append(
        field("プリセット（押すと下の欄に入ります）", presetRow),
        field("一人称", inputs.firstPerson),
        field("語尾", inputs.ending),
        field("口癖", inputs.catchphrase),
        field("その他のしゃべり方指定", textArea(value.extra, set("extra"), "例：ときどき英語を混ぜる")),
      );
    },
    toPrompt(v) {
      const lines = [];
      if (v.firstPerson) lines.push(`一人称は「${v.firstPerson}」。`);
      if (v.ending) lines.push(`語尾は「${v.ending}」。毎回必ず使う。`);
      if (v.catchphrase) lines.push(`口癖は「${v.catchphrase}」。ときどき自然に挟む。`);
      if (v.extra) lines.push(v.extra);
      return lines.length ? `# しゃべり方\n${lines.join("\n")}` : "";
    },
  },

  {
    id: "audio",
    title: "音声・タイミング",
    // ここはアプリの動作設定。AIへの指示文には入れない（toPrompt なし）。
    // 声の演技指示(ttsInstructions)にはキャラ設定を使う。
    defaults: {
      intervalSec: 30, // 何秒ごとにAIに「割り込むか」を聞くか
      silenceSec: 25, // 誰の声も聞こえない状態がこの秒数続いたら、AIに話題づくりを頼む（0でオフ）
      engine: "openai", // "openai"(自然・有料) | "browser"(無料・機械的)
      voiceType: "標準",
      openaiVoice: "coral",
      voiceStyle: "",
      voiceURI: "",
      rate: 1.1,
      pitch: 1.0,
    },
    render(root, value, update) {
      const set = setter(value, update);

      const sliders = {}; // key -> { input, out }
      const range = (key, min, max, step, fmt = (v) => v) => {
        const out = el("output", { textContent: fmt(value[key]) });
        const input = el("input", { type: "range", min, max, step, value: value[key], oninput: (e) => { out.textContent = fmt(e.target.value); set(key)(Number(e.target.value)); } });
        sliders[key] = { input, out, fmt };
        return el("div", { className: "range" }, input, out);
      };

      const engineSelect = el(
        "select",
        { onchange: (e) => set("engine")(e.target.value) },
        el("option", { value: "openai", textContent: "OpenAIの声（自然・少し料金がかかる）", selected: value.engine === "openai" }),
        el("option", { value: "browser", textContent: "ブラウザの声（無料・機械的）", selected: value.engine === "browser" }),
      );

      const openaiSelect = el(
        "select",
        { onchange: (e) => set("openaiVoice")(e.target.value) },
        ...OPENAI_VOICES.map((v) => el("option", { value: v, textContent: v, selected: v === value.openaiVoice })),
      );

      const chips = VOICE_TYPES.map((t) =>
        el("button", {
          type: "button",
          className: `chip${t.label === value.voiceType ? " active" : ""}`,
          textContent: t.label,
          onclick: () => {
            value.voiceType = t.label;
            value.openaiVoice = t.voice;
            openaiSelect.value = t.voice;
            for (const key of ["pitch", "rate"]) {
              value[key] = t[key];
              sliders[key].input.value = t[key];
              sliders[key].out.textContent = t[key];
            }
            chips.forEach((c) => c.classList.toggle("active", c.textContent === t.label));
            update(value);
            document.querySelector("#voice-test")?.click(); // 押したらすぐ試し聞きできる
          },
        }),
      );

      const voiceSelect = el("select", { onchange: (e) => set("voiceURI")(e.target.value) });
      const fillVoices = () => {
        const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith("ja"));
        voiceSelect.replaceChildren(
          el("option", { value: "", textContent: "（自動）" }),
          ...voices.map((v) => el("option", { value: v.voiceURI, textContent: v.name, selected: v.voiceURI === value.voiceURI })),
        );
      };
      fillVoices();
      speechSynthesis.addEventListener("voiceschanged", fillVoices);

      root.append(
        field("AIに「割り込むか」を聞く間隔（秒）", range("intervalSec", 10, 120, 5)),
        field("沈黙が続いたら話題を振る（秒・0でオフ）", range("silenceSec", 0, 120, 5, (v) => (Number(v) === 0 ? "オフ" : v))),
        field("声のエンジン", engineSelect),
        field("声のタイプ（押すと試し聞きできます）", el("div", { className: "chips" }, ...chips)),
        field("OpenAIの声の種類", openaiSelect),
        field("声の演技の指示（自由記述）", textArea(value.voiceStyle, set("voiceStyle"), "例：関西弁のイントネーションで。ささやくように。")),
        el("details", { className: "sub" },
          el("summary", {}, "ブラウザの声の細かい設定"),
          field("声の種類（この端末にある日本語の声）", voiceSelect),
          field("話す速さ", range("rate", 0.6, 1.8, 0.1)),
          field("声の高さ", range("pitch", 0.5, 1.8, 0.1)),
        ),
      );
    },
  },
];

// ---- 保存・読み込み ----
export function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    // 壊れていたら初期値で始める
  }
  const settings = {};
  for (const s of SECTIONS) settings[s.id] = { ...structuredClone(s.defaults), ...(saved[s.id] || {}) };
  return settings;
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 保存できなくても動作は続ける
  }
}

// 設定画面を描画。値が変わるたびに onChange(settings) を呼ぶ。
export function renderSettings(root, settings, onChange) {
  root.replaceChildren();
  for (const section of SECTIONS) {
    const body = el("div", { className: "section-body" });
    section.render(body, settings[section.id], (next) => {
      settings[section.id] = next;
      saveSettings(settings);
      onChange(settings);
    });
    root.append(el("details", { className: "section", open: true }, el("summary", {}, section.title), body));
  }
}

// 設定 → AIへの指示文（設定由来の部分）
export function settingsToPrompt(settings) {
  return SECTIONS.map((s) => s.toPrompt?.(settings[s.id]) || "")
    .filter(Boolean)
    .join("\n\n");
}

// OpenAIの声への演技指示（声のタイプ + 自由記述 + 司会者のキャラ）
export function ttsInstructions(settings) {
  const a = settings.audio;
  const type = VOICE_TYPES.find((t) => t.label === a.voiceType);
  const preset = CHARACTER_PRESETS.find((p) => p.id === settings.character.preset)?.text;
  const character = [preset, settings.character.custom.trim()].filter(Boolean).join(" ");
  return [
    "日本語で、人間の司会者のように自然に、感情を込めて話す。",
    type?.style,
    a.voiceStyle.trim(),
    character && `次のキャラクターを演じる：${character}`,
  ]
    .filter(Boolean)
    .join("\n");
}
