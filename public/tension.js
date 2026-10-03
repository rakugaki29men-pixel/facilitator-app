// テンション(1〜5)の定義と、「今回のテンションをいくつにするか」の決め方。

export const TENSION_LEVELS = [
  { level: 1, label: "とても静か", say: "ぼそぼそと小声で、眠そうに。ため息まじりで、短く。", voice: "ぼそぼそと小声で、眠そうに、テンション低めに。" },
  { level: 2, label: "落ち着き", say: "静かで落ち着いた語り口。ゆったりと。", voice: "静かに落ち着いて、ゆっくりと。" },
  { level: 3, label: "ふつう", say: "ふつうの明るい司会。", voice: "ふつうの明るさで。" },
  { level: 4, label: "高め", say: "高めのテンション。勢いよく、声を張って。", voice: "テンション高めに、声を張って勢いよく。" },
  { level: 5, label: "最高潮", say: "最高潮。叫ぶくらい大げさに、爆発的に盛り上がる。", voice: "大声で叫ぶように、爆発的に興奮して。" },
];

export const TENSION_MODES = [
  { id: "steady", label: "一定（基準のまま）" },
  { id: "ramp", label: "だんだん盛り上げる" },
  { id: "swing", label: "毎回ランダムに急変（落差を楽しむ）" },
  { id: "ai", label: "場の空気に合わせてAIが決める" },
];

export const clampLevel = (n) => Math.min(5, Math.max(1, Math.round(Number(n) || 3)));
export const tensionInfo = (level) => TENSION_LEVELS[clampLevel(level) - 1];

/**
 * 今回のセリフの目標テンション。
 * @param {{base:number, mode:string, rampMin:number}} cfg
 * @param {number} elapsedMs  開始からの経過時間
 * @param {number|null} last  前回のテンション
 */
export function targetTension(cfg, elapsedMs, last) {
  const base = clampLevel(cfg.base);
  if (cfg.mode === "ramp") {
    const progress = Math.min(elapsedMs / (Math.max(cfg.rampMin, 1) * 60_000), 1);
    return clampLevel(base + (5 - base) * progress);
  }
  if (cfg.mode === "swing") {
    // 前回と同じにならないようにくじ引き。静かな回と爆発する回が混ざる
    const choices = [1, 2, 3, 4, 5].filter((l) => l !== last);
    return choices[Math.floor(Math.random() * choices.length)];
  }
  return base; // steady / ai（aiは基準として渡し、実際の値はAIが決める）
}

// ブラウザの声(無料)で、テンションを速さと高さで表すための倍率
export function browserVoiceFactor(level) {
  const l = clampLevel(level);
  return { rate: 0.8 + (l - 1) * 0.1125, pitch: 0.9 + (l - 1) * 0.0625 };
}
