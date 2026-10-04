// 笑い上戸レベル。笑うかどうかは毎回こちらで抽選して、AIと声の演技に伝える。

export const LAUGH_LEVELS = [
  { level: 0, label: "笑わない", p: 0, say: "笑い声は入れない。" },
  { level: 1, label: "ときどき笑う", p: 0.15, say: "ときどき、軽く笑いを混ぜる。「ふふっ」「あはは」程度。" },
  { level: 2, label: "よく笑う", p: 0.4, say: "おもしろいことがあれば、声に出して笑う。「あはははは！」「ひゃはは！」など。" },
  { level: 3, label: "笑い上戸", p: 0.75, say: "ほぼ毎回、セリフの前後や途中で声を上げて笑う。「あーっはっはっは！」「ひーっ、くくく…」など。" },
  { level: 4, label: "笑いが止まらない", p: 0.95, say: "笑いのツボに入って止まらない。セリフの途中でも何度も吹き出し、息も絶え絶えになる。" },
];

export const laughInfo = (level) => LAUGH_LEVELS[Math.min(4, Math.max(0, Math.round(Number(level) || 0)))];

// 今回のセリフに笑いを入れるか
export function drawLaugh(level, rng = Math.random) {
  const info = laughInfo(level);
  return info.p > 0 && rng() < info.p;
}
