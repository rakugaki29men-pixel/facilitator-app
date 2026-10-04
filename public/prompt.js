// AIへの指示文を組み立てる。設定は毎回ここで読み直すので、途中変更が次の判断から反映される。
import { settingsToPrompt } from "./settings.js";

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
    tension.ai
      ? `今回のテンション：基準はレベル${tension.level}。場の空気に合わせて自分で決める`
      : `今回のテンション：レベル${tension.level}（${tension.label}）で話す`,
  ];

  parts.push(laugh.on ? `今回の笑い：入れる（${laugh.label}。${laugh.say}）` : "今回の笑い：入れない");
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
