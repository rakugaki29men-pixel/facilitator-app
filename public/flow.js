// 「誰に話を振るか」の進行ルール。
//  ・全員への質問はしない。必ず1人を名指しして話を振る
//  ・深掘りできそうなら同じ人に続けて振ってよいが、連続で振れるのは maxAsks 回まで
//  ・上限の回では、その人との会話を受けた歌 / ラップ / 一発ギャグで締める
//  ・一発ギャグのあとは、自分で長めに爆笑する
// 回数の数え方はAIに任せると守られないので、数えるのはこちら、AIには毎回「今回どうするか」を渡す。

export const PERF_TYPES = {
  song: {
    label: "歌",
    icon: "🎵",
    spec: "会話の内容を歌詞にした短い歌。節をつけて歌えるように、リズムのよい言葉で作る",
    voice: "この部分は歌う。メロディをつけ、音程を上下させ、言葉を伸ばして節回しをつけて、歌うように発声する。",
  },
  rap: {
    label: "ラップ",
    icon: "🎤",
    spec: "会話の内容をネタにした、韻を踏んだ短いラップ",
    voice: "この部分はラップ。ビートがあるつもりで、リズムに乗せて、歯切れよく、ラップ調で。",
  },
  gag: {
    label: "一発ギャグ",
    icon: "💥",
    spec: "会話の内容をネタにした、短くて分かりやすい一発ギャグ",
    voice: "この部分は一発ギャグ。間（ま）を取って、決めのフレーズを大げさに、自信満々に言い切る。",
  },
};

export const LAUGH_AFTER_VOICE = "長く爆笑する。息が続かなくなり、むせて、ひーひー言いながら笑い転げる。笑いの合間に息継ぎも入れる。";
export const DEFAULT_LAUGH_AFTER = "あーっはっはっは！ひーっ、くくく、あはははは！だめだ、自分で言って自分で笑っちゃう！あーっはっはっは！";

const pick = (list, rng) => list[Math.floor(rng() * list.length)];

/** 設定のチェック状態から、使える芸の一覧を作る */
export const enabledPerfTypes = (rules) => Object.keys(PERF_TYPES).filter((k) => rules[k]);

/**
 * 参加者の名前に当てはめる。「田中さん」「田中くん」なども拾う。
 * 参加者が1人もいないときは null（名前の管理ができないので、ルールを適用しない）。
 */
export function matchParticipant(target, names) {
  if (!names.length) return null;
  const t = String(target ?? "").trim().replace(/(さん|くん|君|ちゃん|様)$/, "");
  if (!t) return "";
  return names.find((n) => n === t) ?? names.find((n) => n.length >= 2 && (t.includes(n) || n.includes(t))) ?? "";
}

/**
 * 今回のセリフの進め方を決める。
 * @param {{focus:{name:string,count:number}|null, cooldown:string|null, maxAsks:number, perfTypes:string[], hasNames:boolean, rng?:()=>number}} s
 * @returns {{text:string, perfType:string|null}}
 */
export function planTurn({ focus, cooldown, maxAsks, perfTypes, hasNames, rng = Math.random }) {
  const lines = [];
  let perfType = null;
  const finalNote = () => {
    perfType = perfTypes.length ? pick(perfTypes, rng) : null;
    if (!perfType) return;
    const t = PERF_TYPES[perfType];
    lines.push(
      `- この発言の最後に「${t.label}」をやる。内容は、これまでのやりとりの内容を反映させる：${t.spec}`,
      "- 内容は performance に入れる。長さは5〜10秒で読める程度（日本語で40〜70文字）",
    );
    if (perfType === "gag") {
      lines.push("- 一発ギャグのあと、自分でそのギャグに長めに爆笑する。その笑い声を laugh_after に入れる（「あーっはっはっは！ひーっ、くくく…」のように30〜50文字）");
    } else {
      lines.push("- laugh_after は空文字にする");
    }
  };

  if (focus && focus.count + 1 >= maxAsks) {
    const nth = focus.count + 1;
    lines.push(
      `- いま${focus.name}さんとやりとり中（${focus.count}回目まで）。今回は${focus.name}さんへの${nth}回目＝上限（${maxAsks}回）`,
      `- ${focus.name}さんの話を受けて返したうえで、締めに入る（この回の target は${focus.name}）`,
    );
    finalNote();
    lines.push(`- これが最後なので、次の発言では${focus.name}さん以外の人を名指しする`);
  } else if (focus) {
    lines.push(
      `- いま${focus.name}さんとやりとり中（${focus.count}回目まで）。続けるなら今回は${focus.count + 1}回目（上限${maxAsks}回）`,
      `- 話が深掘りできそうなら、続けて${focus.name}さんに振る。深掘りできなさそうなら、別の人を名指しして話題を変える`,
      "- performance と laugh_after は空文字にする",
    );
  } else {
    lines.push("- 誰か1人を名前で呼んで話を振る");
    if (cooldown) lines.push(`- 直前に${cooldown}さんへ上限の回数まで振ったので、今回は${cooldown}さん以外を名指しする`);
    if (maxAsks <= 1) {
      lines.push("- 上限が1回なので、この発言の最後に芸をやる");
      finalNote();
    } else {
      lines.push("- performance と laugh_after は空文字にする");
    }
  }
  lines.push(
    "- 「みなさん」など全員に向けた質問はしない",
    hasNames ? "- target に、振った相手の名前（参加者リストのとおり）を入れる。誰にも振らないときは空文字" : "- 参加者リストが空なので、名指しは不要。target は空文字にする",
  );
  return { text: `## 今回の進行（話の振り方）\n${lines.join("\n")}`, perfType };
}

/**
 * AIの返答を受けて、深掘りの状態を更新する。
 * @param {{focus:object|null, cooldown:string|null}} prev
 * @param {string|null} target  名前に当てはめ済みの相手。null=名前管理なし、""=誰にも振っていない
 * @param {number} maxAsks
 */
export function applyTurn(prev, target, maxAsks) {
  if (target === null || target === "") return { focus: null, cooldown: null };
  const count = prev.focus && prev.focus.name === target ? prev.focus.count + 1 : 1;
  if (count >= maxAsks) return { focus: null, cooldown: target }; // 上限に達した。次は別の人
  return { focus: { name: target, count }, cooldown: null };
}
