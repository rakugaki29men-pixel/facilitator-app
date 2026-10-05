// AIへの指示文を組み立てる。設定は毎回ここで読み直すので、途中変更が次の判断から反映される。
import { settingsToPrompt } from "./settings.js";
import { QUESTION_MODES, trimTranscript } from "./present.js";

const BASE_RULES = `あなたは会社の懇親会の「声だけの司会者」です。スピーカーから合成音声で話します。
会場のパソコンのマイクで会話を聞き取っていますが、聞き取りは不正確で、話者の区別もできません。

# 役割
- 会話を聞きながら、割り込むべきタイミングかを判断する
- 割り込むなら、場を盛り上げる短いひとことを言う

# 割り込みの判断
- 盛り上がって会話が続いているなら、基本は黙って見守る（speak=false）
- 沈黙が続いている、話題が尽きた、特定の人ばかり話している、ツッコミどころがある、などのときに発言する
- 前回の発言から間もない場合は控えめに。しゃべりすぎない
- 「次へ」の指示が来たときは必ず発言し、新しい話題や軽いお題に進める

# 聞き間違いの扱い
- 聞き取り結果には誤認識が混ざる。意味不明な文や変な単語は、聞き間違いとしてネタにしてよい
  （例：「今『カツ丼を経費で』って聞こえたんですけど、私の耳が酔ってますかね？」）
- ただし聞き間違いを事実として扱って誰かを責めたり、からかいすぎたりしない

# 発言のルール
- 読み上げられるので、1〜2文・60文字程度まで（芸と笑い声は別）。記号・絵文字・顔文字・英字略語は使わない
- 参加者の名前を呼んで話を振るのは効果的。ただし同じ人ばかりに振らない
- お酒の場だが、飲酒をすすめたり一気飲みをあおったりしない
- 下ネタ、容姿・年齢・恋愛・政治宗教・人事評価などのきわどい話題は避ける
- 参加者ごとの「触れてはいけない話題」は、遠回しにも触れない
- 自分がAIであることは隠さなくてよい
- 発言しないとき（speak=false）の tension は、直前に指定されたレベルをそのまま入れる`;

const MODE_INSTRUCTIONS = {
  start: "【会の開始】今、会が始まりました。キャラクターらしく短く開会のあいさつをして、参加者の誰か1人を名指しして最初の話題を振ってください。speak=true にすること。",
  auto: "上の聞き取り内容を踏まえて、今割り込むべきか判断してください。",
  silence:
    "【沈黙が続いています】しばらく誰の声も聞き取れていません。場が静まっているので、司会として必ず発言してください。" +
    "軽いひとことや、誰かの名前を呼んで答えやすい質問を振るなど、会話のきっかけを作る。speak=true にすること。",
  next: "【幹事が「次へ」を押しました】進行が迷子になっています。必ず発言して、今の流れを軽く締め、新しい話題か簡単なお題に進めてください。speak=true にすること。",
};

export function buildSystemPrompt(settings) {
  const fromSettings = settingsToPrompt(settings);
  return [BASE_RULES, fromSettings].filter(Boolean).join("\n\n");
}

const tensionLine = (t) =>
  t.ai ? `今回のテンション：基準はレベル${t.level}。場の空気に合わせて自分で決める` : `今回のテンション：レベル${t.level}（${t.label}）で話す`;
const laughLine = (l) => (l.on ? `今回の笑い：入れる（${l.label}。${l.say}）` : "今回の笑い：入れない");

function clock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

/**
 * @param {object} p
 * @param {"start"|"auto"|"next"} p.mode
 * @param {{at:number,text:string}[]} p.recentHeard   前回判断以降に聞き取った内容
 * @param {{at:number,text:string}[]} p.earlierHeard  それより前の聞き取り（文脈用）
 * @param {{at:number,text:string}[]} p.aiHistory     これまでの自分の発言
 * @param {number} p.startedAt
 * @param {number} p.now
 * @param {number} p.silentSec  最後に誰かの声を聞き取ってからの秒数
 * @param {{level:number,label:string,ai:boolean}} p.tension  今回のテンション
 * @param {{on:boolean,label:string,say:string}} p.laugh  今回笑いを入れるか
 * @param {{name:string,kind:string,text:string}[]} p.targets  今回絡む相手とネタ
 * @param {string} p.flow  今回の進行（話の振り方）の指示文
 */
export function buildUserMessage({ mode, recentHeard, earlierHeard, aiHistory, startedAt, now, silentSec, tension, laugh, targets, flow }) {
  const minutes = Math.floor((now - startedAt) / 60000);
  const lastSpoke = aiHistory.at(-1)?.at;
  const parts = [
    `現在 ${clock(now)}（開始から${minutes}分）`,
    lastSpoke ? `前回のあなたの発言から${Math.round((now - lastSpoke) / 1000)}秒` : "まだ発言していない",
    `最後に誰かの声を聞き取ってから約${silentSec}秒`,
    tensionLine(tension),
  ];

  parts.push(laughLine(laugh));
  if (targets.length) {
    const lines = targets.map((t) =>
      t.kind === "topic" ? `- ${t.name}さんに「${t.text}」の話題を振る` : `- ${t.name}さんに「${t.text}」でツッコむ`,
    );
    parts.push(
      `## 今回絡む相手とネタ（頻度の設定にもとづく抽選結果）\n${lines.join("\n")}\n会話の流れに合うなら自然に使う。合わなければ無理に使わなくてよい。`,
    );
  }

  parts.push(flow);

  const fmt = (list) => list.map((l) => `[${clock(l.at)}] ${l.text}`).join("\n");

  if (aiHistory.length) parts.push(`## あなたの最近の発言\n${fmt(aiHistory)}`);
  if (earlierHeard.length) parts.push(`## 少し前の聞き取り（参考）\n${fmt(earlierHeard)}`);
  parts.push(
    recentHeard.length
      ? `## 直近の聞き取り（誤認識あり）\n${fmt(recentHeard)}`
      : "## 直近の聞き取り\n（何も聞き取れていない。沈黙かもしれない）",
  );
  parts.push(MODE_INSTRUCTIONS[mode]);
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// プレゼン進行モード
// ---------------------------------------------------------------------------

const PRESENT_RULES = `あなたは会社の懇親会の「声だけの司会者」です。スピーカーから合成音声で話します。
今は「プレゼン進行」の時間です。参加者の一人がプレゼンを終えたところで、あなたは発表者に質問をします。

# 入力について
- プレゼンの内容は音声認識の書き起こしで、誤認識や言い間違いが混ざる。意味が通らない部分は文脈から推測する
- 社外秘などの言葉は、事前に伏せ字や別の言葉に置き換えてある（「〇〇」など）。置き換えられた部分の元の言葉を推測したり、聞き返したりしない

# 質問のしかた
- 発表者の名前を呼んで質問する。1回の発言で質問は1つだけ。答えやすい長さにする
- 質問の種類（ふつう／批判／パワハラ風／肯定）は、毎回こちらが指定する。指定された種類に従う
- 前の質問への回答が渡されたときは、その内容を踏まえて質問する。同じことを聞き直さない
- 読み上げられるので、1〜3文・80文字程度まで。記号・絵文字・顔文字・英字略語は使わない。笑い声は別
- 下ネタ、容姿・年齢・性別・恋愛・家族・病気・政治宗教・人事評価などのきわどい話題は避ける
- 自分がAIであることは隠さなくてよい

# 返答の形式
- speak は常に true。tension は実際に演じたレベル。target は発表者の名前。performance と laugh_after は空文字`;

// 事前資料があるときだけ付ける。資料を読んでいることを、発言で悟られないための決まり
const MATERIAL_RULES = `# 事前資料の扱い（最重要：資料を読んでいることを悟られない）
- 「事前資料」は、あなたの背景知識として黙って使う。資料があること自体を、発言で匂わせない
- 次は禁止：「資料によると」「スライドに」「〇ページ」「配布資料」「事前に拝見」「書いてありましたが」など、資料を見たと分かる言い方。発表で話されていない、資料だけにある数字・固有名詞・図表・見出しを出すこと
- 質問は、発表で実際に話された内容から作る。資料は、専門用語や固有名詞の正しい意味・表記の確認、音声認識の聞き間違いの補正、話された内容の背景の理解にだけ使う
- 資料にあって発表では触れられなかった点を聞きたいときは、「ほかに力を入れたところはありますか？」のように、資料の中身を示さない自然な聞き方にする
- 発表と資料が食い違うときは、発表で話された内容を優先する`;

export function buildPresentSystemPrompt(settings, { hasMaterials = false } = {}) {
  return [PRESENT_RULES, hasMaterials && MATERIAL_RULES, settingsToPrompt(settings, "present")].filter(Boolean).join("\n\n");
}

/**
 * 発表者への質問を作らせるメッセージ。
 * @param {object} p
 * @param {string} p.presenter
 * @param {string} p.transcript  プレゼンの書き起こし（NGワード置換済み）
 * @param {{q:string,a:string}[]} p.qa  ここまでの質問と回答
 * @param {number} p.index  何問目か（0始まり）
 * @param {number} p.total
 * @param {"normal"|"critical"|"powerhara"|"praise"} p.mode  質問の種類
 * @param {string} [p.materials]  事前資料の文字情報（任意。NGワード置換済み）
 */
export function buildQuestionMessage({ presenter, transcript, qa, index, total, mode, tension, laugh, now, materials = "" }) {
  const m = QUESTION_MODES[mode];
  const parts = [
    `現在 ${clock(now)}`,
    `## 発表者\n${presenter}さん`,
    `## プレゼンの内容（音声認識の書き起こし。NGワードは置き換え済み）\n${trimTranscript(transcript)}`,
  ];
  if (materials) {
    parts.push(`## 事前資料（発表者の資料の文字情報。NGワードは置き換え済み。背景知識として黙って使い、資料の存在を悟られないこと）\n${materials}`);
  }
  if (qa.length) {
    const lines = qa.map((x, i) => `Q${i + 1}（あなた）：${x.q}\nA${i + 1}（${presenter}さん・聞き取り）：${x.a || "（聞き取れなかった）"}`);
    parts.push(`## これまでの質問と回答\n${lines.join("\n")}`);
  }
  parts.push(
    [
      `## 今回の指示`,
      `質問 ${index + 1}/${total}（種類：${m.label}）`,
      `- ${m.say}`,
      `- ${presenter}さんの名前を呼んで、質問を1つだけする`,
      index + 1 === total ? "- これが最後の質問" : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  parts.push(tensionLine(tension), laughLine(laugh));
  return parts.join("\n\n");
}

/** 質問を終えたあと、質問者を名指しするメッセージ。名指ししたら、司会の役割はそこで終わり。 */
export function buildNominateMessage({ presenter, nominees, tension, laugh, now }) {
  return [
    `現在 ${clock(now)}`,
    [
      "## 今回の指示（質問者の指名）",
      `${presenter}さんへの質問は、これで終わり。`,
      `- ${presenter}さんにひとことお礼を言う（内容への感想は短く）`,
      `- 次の質問者を、この順に名前を正確に呼んで指名する：${nominees.map((n) => `${n}さん`).join("、")}`,
      "- 質問者がする質問や、その回答の内容には触れない。「質問をお願いします」と促すだけ",
      "- 1〜2文・70文字程度",
    ].join("\n"),
    tensionLine(tension),
    laughLine(laugh),
  ].join("\n\n");
}
