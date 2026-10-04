// 参加者ごとの「振りたい話題」「ツッコミワード」を、頻度に応じて毎回抽選する。
// 頻度の指定をAIに任せると守られないので、抽選はこちらで行い、当たったものだけをAIに渡す。

export const FREQUENCIES = [
  { level: 1, label: "控えめ（たまに）", p: 0.1 },
  { level: 2, label: "ふつう", p: 0.25 },
  { level: 3, label: "多め", p: 0.45 },
  { level: 4, label: "しつこいくらい", p: 0.7 },
];

const MAX_PER_TURN = 2; // 1回のセリフで同時に絡む人数の上限

// 「、」「,」「改行」区切りの文字列を配列にする
export function splitList(text) {
  return String(text ?? "")
    .split(/[、,，\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export const freqInfo = (level) => FREQUENCIES.find((f) => f.level === Number(level)) ?? FREQUENCIES[1];

/**
 * @param {{name:string, topics?:string, pokes?:string, freq?:number}[]} people
 * @param {{rng?:()=>number, lastNames?:string[]}} [o]  lastNames: 前回のセリフで絡んだ人（連続を避ける）
 * @returns {{name:string, kind:"topic"|"poke", text:string}[]}
 */
export function drawTargets(people, { rng = Math.random, lastNames = [] } = {}) {
  const hits = [];
  for (const p of people) {
    const name = p.name?.trim();
    if (!name) continue;
    const items = [
      ...splitList(p.topics).map((text) => ({ kind: "topic", text })),
      ...splitList(p.pokes).map((text) => ({ kind: "poke", text })),
    ];
    if (!items.length) continue;
    const f = freqInfo(p.freq);
    // 前回絡んだ人は、しつこいくらい(4)以外は1回休み
    if (lastNames.includes(name) && f.level < 4) continue;
    if (rng() >= f.p) continue;
    const item = items[Math.floor(rng() * items.length)];
    hits.push({ name, ...item });
  }
  // 当たりが多すぎるときはランダムに絞る
  while (hits.length > MAX_PER_TURN) hits.splice(Math.floor(rng() * hits.length), 1);
  return hits;
}
