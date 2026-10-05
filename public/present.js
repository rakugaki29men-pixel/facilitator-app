// プレゼン進行モードの中身（画面に依存しない部分）。
//  ・NGワードの置換/削除（AIに送る前に社外秘などを消す）
//  ・質問の種類（ふつう / 批判 / パワハラ風 / 肯定）
//  ・質問者の指名（全体を通して、同じ人に偏らないように）

import { splitList } from "./pokes.js";

export const QUESTION_MODES = {
  normal: {
    label: "ふつう",
    icon: "💬",
    say: "素朴で的確な質問。発表のポイントや、聞いていて気になった点を掘り下げる。",
  },
  critical: {
    label: "批判",
    icon: "🔥",
    say:
      "あえて批判的に突っ込む。主張の根拠の甘さ、見落とし、反対の立場からの意見を指摘して、そのうえで質問する。" +
      "批判の対象は発表の「内容」。口調は丁寧だが鋭く。人格や能力への攻撃はしない。",
  },
  powerhara: {
    label: "パワハラ風（コント）",
    icon: "👹",
    say:
      "コントとして、時代錯誤で理不尽な「昭和の鬼上司」を大げさに演じる（「俺の若い頃はな」「気合いが足りん」「で、それ何の役に立つんだ」など）。" +
      "笑えるレベルまで誇張する。攻撃してよいのは発表の「内容」と大げさな精神論だけ。" +
      "次は禁止：容姿・年齢・性別・家族・病気・国籍・能力そのものへの攻撃、人格否定、脅し、実際の人事評価や処遇に触れること、下ネタ。最後は質問の形で終える。",
  },
  praise: {
    label: "肯定（ほめ）",
    icon: "🌸",
    say: "発表のよかった点を具体的に、心からほめる。そのうえで前向きで答えやすい質問をして、場が明るく終わる形にする。",
  },
};

// 質問の型。毎回「見解 → 質問」の順に話す。質問は、確認型と掘り下げ型を交互に使う
export const QUESTION_FORMS = {
  confirm: {
    label: "確認型",
    say: "発表の主張や要点を、自分の言葉で言い換えて、「これは〇〇ということですか？」と確かめる（発表者の言葉を引用してよい）",
  },
  dig: {
    label: "掘り下げ型",
    say: "理由・背景・根拠・具体例・きっかけ・他との違い・今後どうするか、のどれかを、一段深く聞く",
  },
};

/** 何問目かで、質問の型を決める（1問目は確認型、2問目は掘り下げ型、3問目は確認型…） */
export const formFor = (index) => (index % 2 === 0 ? "confirm" : "dig");

/** 質問の数に応じた、種類の初期値。最後の質問は、良い形で終わるために肯定（ほめ） */
export function defaultFlags(count) {
  return Array.from({ length: count }, (_, i) => (i === count - 1 ? "praise" : "normal"));
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * NGワードを置換（置換語が空なら削除）する。
 * 1行に「、」区切りで言い換えや読み方を並べられる（例：プロジェクトX、ぷろじぇくとえっくす）。
 * @param {string} text
 * @param {{word:string, to?:string}[]} entries
 * @returns {{text:string, hits:{word:string,to:string,count:number}[], total:number}}
 */
export function applyNg(text, entries) {
  const rules = [];
  for (const e of entries ?? []) {
    for (const word of splitList(e.word)) rules.push({ word, to: String(e.to ?? "") });
  }
  rules.sort((a, b) => b.word.length - a.word.length); // 長い語を先に（部分一致で壊さない）
  let out = String(text ?? "");
  const hits = [];
  for (const r of rules) {
    let count = 0;
    out = out.replace(new RegExp(escapeRegExp(r.word), "gi"), () => {
      count++;
      return r.to;
    });
    if (count) hits.push({ ...r, count });
  }
  return { text: out, hits, total: hits.reduce((n, h) => n + h.count, 0) };
}

/** 置換の結果を、同じ語句どうしでまとめる（確認画面に累計を出すため） */
export function mergeHits(a, b) {
  const map = new Map();
  for (const h of [...a, ...b]) {
    const key = `${h.word}\u0000${h.to}`;
    map.set(key, { ...h, count: (map.get(key)?.count ?? 0) + h.count });
  }
  return [...map.values()];
}

/**
 * 質問者を選ぶ。発表者は除き、これまでの指名回数が少ない人を優先する（同じなら乱数）。
 * @param {string[]} names       参加者の名前
 * @param {Record<string,number>} counts  これまでの指名回数
 * @param {string} presenter
 * @param {number} k
 */
export function pickNominees(names, counts, presenter, k, rng = Math.random) {
  const pool = [...new Set(names.map((n) => n.trim()).filter((n) => n && n !== presenter))];
  return pool
    .map((name) => ({ name, count: counts[name] ?? 0, r: rng() }))
    .sort((a, b) => a.count - b.count || a.r - b.r)
    .slice(0, k)
    .map((x) => x.name);
}

/** 長すぎる書き起こしは、新しい側を残して切る */
export function trimTranscript(text, max = 12000) {
  const t = String(text ?? "");
  return t.length <= max ? t : `（前半は省略）\n${t.slice(t.length - max)}`;
}
