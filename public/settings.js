// 設定項目の登録簿。
// 項目を増やすときは SECTIONS に1つ追加するだけでよい：
//   id       : 保存キー
//   title    : 設定画面の見出し
//   defaults : 初期値
//   render   : (要素, 現在値, 変更通知) => void   設定UIを描画
//   toPrompt : (値) => string | ""              AIへの指示文に入れる文章（不要なら省略）

import { TENSION_LEVELS, TENSION_MODES, tensionInfo } from "./tension.js";
import { FREQUENCIES, freqInfo, splitList } from "./pokes.js";
import { LAUGH_LEVELS, laughInfo } from "./laugh.js";
import { PERF_TYPES, LAUGH_AFTER_VOICE } from "./flow.js";

export const STORAGE_KEY = "facilitator-settings-v1";

export const CHARACTER_PRESETS = [
  { id: "kansai", icon: "🎤", label: "関西の芸人司会", text: "ノリとツッコミが命の関西芸人。ボケを拾ってツッコみ、場を笑いで回す。" },
  { id: "veteran", icon: "🍻", label: "ベテラン宴会司会", text: "場慣れした落ち着きのある宴会司会。全員に目を配り、さりげなく話を振る。" },
  { id: "jikkyo", icon: "📣", label: "熱血スポーツ実況", text: "何でも実況してしまう熱血アナウンサー。会話の盛り上がりを試合のように中継する。" },
  { id: "butler", icon: "🎩", label: "老執事", text: "丁寧すぎる老執事。皆様をおもてなしするが、ときどき天然な発言をする。" },
  { id: "yuru", icon: "🐻", label: "ゆるキャラ", text: "ふわっとしたゆるキャラ。のんびりしているが、急に核心を突く。" },
  { id: "none", icon: "🎙️", label: "（なし・自由記述のみ）", text: "" },
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
  { label: "熱血主人公風", voice: "echo", style: "熱血青春アニメの主人公のように、まっすぐで熱く、叫ぶように。", pitch: 1.1, rate: 1.3 },
  { label: "ツンデレ風", voice: "nova", style: "素直になれないツンデレ風。きつめに言いつつ、ときどき照れる。", pitch: 1.3, rate: 1.15 },
  { label: "ミステリアス", voice: "sage", style: "ミステリアスで色気のある語り。声を抑え、含みを持たせてゆっくり。", pitch: 0.8, rate: 0.9 },
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

      // 追加項目がない古い保存データも読めるようにそろえる
      for (const p of value.list) {
        p.topics ??= "";
        p.pokes ??= "";
        p.ng ??= "";
        p.freq ??= 2;
      }
      const summaryText = (p) => {
        const n = splitList(p.topics).length + splitList(p.pokes).length;
        return n || p.ng.trim() ? `話題・ツッコミ設定（話題とネタ${n}件${p.ng.trim() ? "・NGあり" : ""}）` : "話題・ツッコミ設定";
      };

      const draw = () => {
        list.replaceChildren();
        if (value.list.length === 0) list.append(el("p", { className: "hint" }, "まだ誰もいません。下から追加してください。"));
        value.list.forEach((p, i) => {
          const summary = el("summary", {}, summaryText(p));
          const edit = (key) => (v) => {
            p[key] = v;
            summary.textContent = summaryText(p);
            commit();
          };
          const freq = el(
            "select",
            { onchange: (e) => edit("freq")(Number(e.target.value)) },
            ...FREQUENCIES.map((f) => el("option", { value: f.level, textContent: f.label, selected: f.level === Number(p.freq) })),
          );
          list.append(
            el(
              "div",
              { className: "participant-card" },
              el(
                "div",
                { className: "participant-row" },
                textInput(p.name, edit("name"), "名前"),
                textInput(p.memo, edit("memo"), "ひとことメモ（例：カラオケ好き）"),
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
              el(
                "details",
                { className: "sub" },
                summary,
                field("振りたい話題（「、」で区切る）", textInput(p.topics, edit("topics"), "例：週末のゴルフ、最近ハマっているもの")),
                field("ツッコミワード（「、」で区切る）", textInput(p.pokes, edit("pokes"), "例：また遅刻、寝ぐせ、それ前も聞いた")),
                field("触れてはいけない話題（NG）", textInput(p.ng, edit("ng"), "例：年齢、お酒を飲めない理由")),
                field("話題・ツッコミで絡む頻度（毎回くじ引きします）", freq),
              ),
            ),
          );
        });
      };

      const nameIn = textInput("", () => {}, "名前");
      const memoIn = textInput("", () => {}, "ひとことメモ");
      const add = () => {
        const name = nameIn.value.trim();
        if (!name) return nameIn.focus();
        value.list.push({ id: newId(), name, memo: memoIn.value.trim(), topics: "", pokes: "", ng: "", freq: 2 });
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
    toPrompt(v, mode) {
      const people = v.list.filter((p) => p.name.trim());
      if (!people.length) return "";
      const lines = people.map((p) => {
        const ng = splitList(p.ng);
        return [`- ${p.name}${p.memo ? `：${p.memo}` : ""}`, ng.length && `  - 触れてはいけない話題（絶対に話題にしない）：${ng.join("、")}`]
          .filter(Boolean)
          .join("\n");
      });
      return [
        `# 参加者（${people.length}人）`,
        lines.join("\n"),
        "※聞き取った名前が多少違っても、近い名前ならこの人たちのことだと推測してよい。",
        mode === "party" &&
          "※各人の「振りたい話題」「ツッコミワード」は、頻度の設定にもとづいて毎回こちらで抽選し、「今回絡む相手とネタ」として渡す。渡されたものだけを使い、渡されていない人のネタを勝手に持ち出さない。",
      ]
        .filter(Boolean)
        .join("\n");
    },
  },

  {
    id: "character",
    title: "司会者のキャラ",
    defaults: { preset: "kansai", custom: "", icon: "" },
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
        field("トーク画面のアイコン（絵文字1つ。空欄ならプリセットの絵）", textInput(value.icon, set("icon"), "例：🐶")),
      );
    },
    toPrompt(v) {
      const preset = CHARACTER_PRESETS.find((p) => p.id === v.preset)?.text || "";
      const text = [preset, v.custom.trim()].filter(Boolean).join("\n");
      return text ? `# あなたのキャラクター\n${text}` : "";
    },
  },

  {
    id: "tension",
    title: "テンション",
    defaults: { base: 3, mode: "steady", rampMin: 60 },
    render(root, value, update) {
      const set = setter(value, update);
      const out = el("output", { textContent: `${value.base}　${tensionInfo(value.base).label}` });
      const slider = el("input", {
        type: "range", min: 1, max: 5, step: 1, value: value.base,
        oninput: (e) => { out.textContent = `${e.target.value}　${tensionInfo(e.target.value).label}`; set("base")(Number(e.target.value)); },
      });
      const mode = el(
        "select",
        { onchange: (e) => set("mode")(e.target.value) },
        ...TENSION_MODES.map((m) => el("option", { value: m.id, textContent: m.label, selected: m.id === value.mode })),
      );
      const rampOut = el("output", { textContent: `${value.rampMin}分` });
      const ramp = el("input", {
        type: "range", min: 10, max: 180, step: 10, value: value.rampMin,
        oninput: (e) => { rampOut.textContent = `${e.target.value}分`; set("rampMin")(Number(e.target.value)); },
      });
      root.append(
        field("基本のテンション（1:とても静か 〜 5:最高潮）", el("div", { className: "range" }, slider, out)),
        field("テンションの変化のさせかた", mode),
        field("「だんだん盛り上げる」で最高潮になるまでの時間", el("div", { className: "range" }, ramp, rampOut)),
      );
    },
    toPrompt(v) {
      const levels = TENSION_LEVELS.map((t) => `  ${t.level}（${t.label}）：${t.say}`).join("\n");
      const how = {
        steady: `基本はレベル${v.base}のテンションで一貫して話す。`,
        ramp: `レベル${v.base}から始めて、時間とともに最高潮に向けてだんだん上げていく。毎回、指示されたレベルに従う。`,
        swing: "毎回のレベルはこちらが指定する。急に静かになったり爆発したり、前回との落差をわざと大げさに演じて楽しませる。",
        ai: `基準はレベル${v.base}。場の空気に合わせて1〜5で自分で決める。盛り上がっていれば上げ、しんみりしていれば下げ、たまに急に変えて驚かせてもよい。`,
      }[v.mode];
      return `# テンション（1〜5）\n${how}\n${levels}\n返答の tension には、実際に演じたレベルを入れる。`;
    },
  },

  {
    id: "rules",
    modes: ["party"], // 飲み会モードだけ
    title: "話の振り方・締めの芸",
    defaults: { maxAsks: 3, rap: true, gag: true },
    render(root, value, update) {
      const set = setter(value, update);
      const out = el("output", { textContent: `${value.maxAsks}回` });
      const slider = el("input", {
        type: "range", min: 1, max: 10, step: 1, value: value.maxAsks,
        oninput: (e) => { out.textContent = `${e.target.value}回`; set("maxAsks")(Number(e.target.value)); },
      });
      const check = (key) =>
        el("label", { className: "check" },
          el("input", { type: "checkbox", checked: value[key], onchange: (e) => set(key)(e.target.checked) }),
          `${PERF_TYPES[key].icon} ${PERF_TYPES[key].label}`);
      root.append(
        field("同じ人に連続で振れる回数の上限（深掘りできるのはこの回数まで）", el("div", { className: "range" }, slider, out)),
        field("上限の回の締めにやる芸（チェックしたものからランダム）", el("div", { className: "checks" }, check("rap"), check("gag"))),
        el("p", { className: "hint" }, "全員への質問はせず、必ず1人を名指しして振ります。一発ギャグのあとは自分で長めに爆笑します。芸をすべてオフにすると、上限だけ守って締めの芸はしません。"),
      );
    },
    toPrompt(v) {
      const types = Object.keys(PERF_TYPES).filter((k) => v[k]).map((k) => PERF_TYPES[k].label);
      return [
        "# 話の振り方のルール",
        "- 「みなさんは」など全員に向けた質問はしない。必ず参加者の誰か1人を名前で呼んで話を振る（参加者リストが空のときだけ例外）",
        "- 相手の話が深掘りできそうなら、続けて同じ人に聞いてよい。深掘りできなさそうなら、早めに別の人へ移る",
        `- 同じ人に連続で振れるのは最大${v.maxAsks}回まで。回数はこちらで数えて、毎回「今回の進行」として指示する`,
        types.length
          ? `- 上限の回には、その人との会話の内容を反映した5〜10秒ほどの芸（${types.length > 1 ? `${types.join("・")}のどれか。こちらが指定する` : types[0]}）で締める。一発ギャグのあとは、自分で長めに爆笑する`
          : "- 締めの芸はしない",
        "- 返答の target に振った相手の名前、performance に締めの芸、laugh_after にギャグのあとの爆笑を入れる。指示がない回は performance と laugh_after を空文字にする",
      ].join("\n");
    },
  },

  {
    id: "ngwords",
    title: "NGワード（プレゼンの伏せ字・削除）",
    modes: ["present"],
    defaults: { list: [] },
    render(root, value, update) {
      const list = el("div", { className: "ng-list" });
      const commit = () => update(value);
      const draw = () => {
        list.replaceChildren();
        if (value.list.length === 0) list.append(el("p", { className: "hint" }, "まだありません。下から追加してください。"));
        value.list.forEach((e, i) => {
          list.append(
            el(
              "div",
              { className: "participant-row ng-row" },
              textInput(e.word, (v) => ((e.word = v), commit()), "NGワード（言い換え・読みは「、」で）"),
              textInput(e.to, (v) => ((e.to = v), commit()), "置換語（空なら削除）"),
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
      const wordIn = textInput("", () => {}, "NGワード");
      const toIn = textInput("", () => {}, "置換語（空=削除）");
      const add = () => {
        if (!wordIn.value.trim()) return wordIn.focus();
        value.list.push({ word: wordIn.value.trim(), to: toIn.value.trim() });
        wordIn.value = toIn.value = "";
        commit();
        draw();
        wordIn.focus();
      };
      for (const input of [wordIn, toIn]) input.addEventListener("keydown", (e) => e.key === "Enter" && !e.isComposing && add());
      draw();
      root.append(
        el("p", { className: "hint" }, "プレゼンの書き起こしをAIに送る前に、ここの語句を自動で置き換え（置換語が空なら削除）ます。読み方（ひらがな）や言い換えは「、」で区切って1行にまとめられます。"),
        list,
        el("div", { className: "participant-row ng-row add-row" }, wordIn, toIn,
          el("button", { type: "button", className: "icon-btn add", title: "追加", textContent: "＋", onclick: add })),
      );
    },
  },

  {
    id: "presentation",
    title: "プレゼン進行",
    modes: ["present"],
    defaults: { style: "serious", questions: 3, nominees: 2, answerSilenceSec: 4, answerMaxWaitSec: 30 },
    render(root, value, update) {
      const set = setter(value, update);
      const select = (key, options, unit) =>
        el("select", { onchange: (e) => set(key)(Number(e.target.value)) },
          ...options.map((n) => el("option", { value: n, textContent: `${n}${unit}`, selected: n === value[key] })));
      const range = (key, min, max, step) => {
        const out = el("output", { textContent: `${value[key]}秒` });
        const input = el("input", { type: "range", min, max, step, value: value[key], oninput: (e) => { out.textContent = `${e.target.value}秒`; set(key)(Number(e.target.value)); } });
        return el("div", { className: "range" }, input, out);
      };
      const style = el("select", { onchange: (e) => set("style")(e.target.value) },
        el("option", { value: "serious", textContent: "じっくり（発表の内容を重視。笑いやテンションの急変はなし）", selected: value.style !== "lively" }),
        el("option", { value: "lively", textContent: "にぎやか（飲み会と同じノリ。テンション・笑いの設定を使う）", selected: value.style === "lively" }));
      root.append(
        field("司会のノリ", style),
        field("発表者への質問の数（初期値。送信前にその場で変えられます）", select("questions", [2, 3], "つ")),
        field("質問者として指名する人数（初期値。その場で変えられます）", select("nominees", [2, 3], "人")),
        field("答えが終わったとみなす沈黙（秒）", range("answerSilenceSec", 2, 10, 1)),
        field("答えが始まらないときに待つ最大の秒数", range("answerMaxWaitSec", 10, 90, 5)),
      );
    },
  },

  {
    id: "laugh",
    title: "笑い上戸",
    defaults: { level: 1 },
    render(root, value, update) {
      const set = setter(value, update);
      const out = el("output", { textContent: `${value.level}　${laughInfo(value.level).label}` });
      const slider = el("input", {
        type: "range", min: 0, max: 4, step: 1, value: value.level,
        oninput: (e) => { out.textContent = `${e.target.value}　${laughInfo(e.target.value).label}`; set("level")(Number(e.target.value)); },
      });
      root.append(
        field("笑いやすさ（0:笑わない 〜 4:笑いが止まらない）", el("div", { className: "range" }, slider, out)),
        el("button", { type: "button", id: "laugh-test", textContent: "😂 笑いのテスト" }),
      );
    },
    toPrompt(v) {
      if (v.level <= 0) return "# 笑い\n笑い声は入れない。";
      return [
        "# 笑い",
        `笑いやすさはレベル${v.level}（${laughInfo(v.level).label}）：${laughInfo(v.level).say}`,
        "笑うかどうかは毎回こちらで抽選して指示する。「笑いを入れる」と指示されたときだけ、セリフに笑い声を入れる。",
        "笑い声は、ひらがなで「あはははは！」「ふふっ」「ひーっ、くくく」のように書く（文字数の目安には含めない）。参加者の発言や聞き間違いがおもしろいときに、それを受けて笑う。",
      ].join("\n");
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
    render(root, value, update, mode) {
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
        ...(mode === "present"
          ? []
          : [
              field("AIに「割り込むか」を聞く間隔（秒）", range("intervalSec", 10, 120, 5)),
              field("沈黙が続いたら話題を振る（秒・0でオフ）", range("silenceSec", 0, 120, 5, (v) => (Number(v) === 0 ? "オフ" : v))),
            ]),
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
// mode: "party"（飲み会） | "present"（プレゼン進行）。section.modes があれば、そのモードのときだけ表示する。
export function renderSettings(root, settings, onChange, mode = "party") {
  root.replaceChildren();
  for (const section of SECTIONS) {
    if (section.modes && !section.modes.includes(mode)) continue;
    const body = el("div", { className: "section-body" });
    section.render(body, settings[section.id], (next) => {
      settings[section.id] = next;
      saveSettings(settings);
      onChange(settings);
    }, mode);
    root.append(el("details", { className: "section", open: true }, el("summary", {}, section.title), body));
  }
}

// 設定 → AIへの指示文（設定由来の部分）
export function settingsToPrompt(settings, mode = "party") {
  return SECTIONS.filter((s) => !s.modes || s.modes.includes(mode))
    .map((s) => s.toPrompt?.(settings[s.id], mode) || "")
    .filter(Boolean)
    .join("\n\n");
}

// OpenAIの声への演技指示（声のタイプ + 自由記述 + 司会者のキャラ）
export function ttsInstructions(settings, { tension, laugh, segment, perfType } = {}) {
  const a = settings.audio;
  const type = VOICE_TYPES.find((t) => t.label === a.voiceType);
  const preset = CHARACTER_PRESETS.find((p) => p.id === settings.character.preset)?.text;
  const character = [preset, settings.character.custom.trim()].filter(Boolean).join(" ");
  return [
    "日本語で、人間の司会者のように自然に、感情を込めて話す。",
    type?.style,
    a.voiceStyle.trim(),
    character && `次のキャラクターを演じる：${character}`,
    tension && `テンションはレベル${tension}/5（${tensionInfo(tension).label}）。${tensionInfo(tension).voice}`,
    laugh && `笑い声（「はは」「あはは」など）の部分は、棒読みせず、本当に笑っているように息を弾ませて演じる。笑いの度合い：${laughInfo(settings.laugh.level).label}。`,
    segment === "perform" && PERF_TYPES[perfType]?.voice,
    segment === "laugh" && LAUGH_AFTER_VOICE,
  ]
    .filter(Boolean)
    .join("\n");
}

// トーク中画面に出すキャラの見た目
export function characterView(settings) {
  const c = settings.character;
  const preset = CHARACTER_PRESETS.find((p) => p.id === c.preset);
  return {
    icon: c.icon.trim() || preset?.icon || "🎙️",
    name: preset && preset.id !== "none" ? preset.label : "司会者",
  };
}
