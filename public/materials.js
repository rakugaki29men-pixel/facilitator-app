// 発表者ごとの事前資料（任意）。ファイルから文字情報を取り出し、この端末のブラウザに保存する。
//  対応: PDF / PowerPoint(.pptx) / Word(.docx) / テキスト(.txt .md .csv)
//  読めるのは文字だけ（図・画像の中の文字、画像だけのPDFは読めない）。ファイルそのものは保存しない。
import { applyNg } from "./present.js";

const KEY = "facilitator-materials-v1";
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_CHARS_PER_FILE = 30000;
export const MAX_CHARS_TOTAL = 30000; // AIに渡す合計の上限
export const ACCEPT = ".pdf,.pptx,.docx,.txt,.md,.csv";

// ---- 保存（発表者の名前 → ファイルの配列） ----
export function loadMaterials() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
}

/** @returns {boolean} 保存できたか（容量オーバーなどで失敗しうる） */
export function saveMaterials(store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

export const materialsFor = (store, person) => store[person] ?? [];

/** 同じ名前のファイルは置き換える */
export function addMaterial(store, person, file) {
  const rest = materialsFor(store, person).filter((f) => f.name !== file.name);
  return { ...store, [person]: [...rest, file] };
}

export function removeMaterial(store, person, id) {
  const next = materialsFor(store, person).filter((f) => f.id !== id);
  const copy = { ...store };
  if (next.length) copy[person] = next;
  else delete copy[person];
  return copy;
}

/**
 * AIに渡す文章にまとめる。NGワードを当てて、合計の文字数を制限する。
 * @returns {{text:string, chars:number, hits:object[], truncated:boolean}}
 */
export function buildMaterialText(files, ngEntries) {
  let hits = [];
  const parts = files.map((f) => {
    const r = applyNg(f.text, ngEntries);
    hits = hits.concat(r.hits);
    return `【資料：${f.name}】\n${r.text}`;
  });
  let text = parts.join("\n\n");
  const truncated = text.length > MAX_CHARS_TOTAL;
  if (truncated) text = `${text.slice(0, MAX_CHARS_TOTAL)}\n（以下省略）`;
  return { text, chars: text.length, hits, truncated };
}

// ---- 文字の取り出し ----
export function decodeXml(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** XMLから、段落ごとの文字を取り出す（pptx: a:p / a:t、docx: w:p / w:t） */
export function xmlParagraphs(xml, pTag, tTag) {
  const lines = [];
  const paragraph = new RegExp(`<${pTag}(?:\\s[^>]*)?>[\\s\\S]*?</${pTag}>`, "g");
  const run = new RegExp(`<${tTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tTag}>`, "g");
  for (const p of xml.match(paragraph) ?? []) {
    const line = [...p.matchAll(run)].map((m) => decodeXml(m[1])).join("").trim();
    if (line) lines.push(line);
  }
  return lines;
}

const numberOf = (path) => Number(path.match(/(\d+)\.xml$/)?.[1] ?? 0);
const byNumber = (a, b) => numberOf(a) - numberOf(b);

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`${src} を読み込めませんでした`));
    document.head.append(s);
  });
}
let jszipPromise = null;
let pdfjsPromise = null;
const getJSZip = () => (jszipPromise ??= loadScript("vendor/jszip.min.js").then(() => window.JSZip));
const getPdfjs = () =>
  (pdfjsPromise ??= loadScript("vendor/pdf.min.js").then(() => {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
    return window.pdfjsLib;
  }));

async function extractPptx(buffer) {
  const zip = await (await getJSZip()).loadAsync(buffer);
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(byNumber);
  const notes = Object.keys(zip.files).filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n));
  const noteOf = new Map();
  for (const n of notes) noteOf.set(numberOf(n), xmlParagraphs(await zip.file(n).async("string"), "a:p", "a:t"));
  const out = [];
  for (const path of slides) {
    const no = numberOf(path);
    const body = xmlParagraphs(await zip.file(path).async("string"), "a:p", "a:t");
    // ノートには、スライド番号などの1〜2文字だけの行も入るので除く
    const note = (noteOf.get(no) ?? []).filter((l) => l.length > 2);
    const text = [...body, ...(note.length ? ["（発表者ノート）", ...note] : [])].join("\n");
    if (text) out.push(`＜スライド${no}＞\n${text}`);
  }
  return { text: out.join("\n\n"), count: slides.length, unit: "スライド" };
}

async function extractDocx(buffer) {
  const zip = await (await getJSZip()).loadAsync(buffer);
  const doc = zip.file("word/document.xml");
  if (!doc) throw new Error("Wordファイルとして読めませんでした");
  return { text: xmlParagraphs(await doc.async("string"), "w:p", "w:t").join("\n"), count: 1, unit: "文書" };
}

async function extractPdf(buffer) {
  const pdfjs = await getPdfjs();
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer), cMapUrl: "vendor/cmaps/", cMapPacked: true }).promise;
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    let text = "";
    for (const item of content.items) text += item.str + (item.hasEOL ? "\n" : "");
    text = text.replace(/[ \t]+\n/g, "\n").trim();
    if (text) out.push(`＜ページ${i}＞\n${text}`);
  }
  return { text: out.join("\n\n"), count: pdf.numPages, unit: "ページ" };
}

/**
 * ファイルから文字を取り出す。
 * @param {File} file
 * @returns {Promise<{id:string,name:string,kind:string,text:string,chars:number,count:number,unit:string,truncated:boolean}>}
 */
export async function extractFile(file) {
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} は大きすぎます（25MBまで）`);
  const ext = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  let r;
  if (["txt", "md", "csv"].includes(ext)) {
    const text = await file.text();
    r = { text, count: 1, unit: "テキスト" };
  } else if (ext === "pdf") {
    r = await extractPdf(await file.arrayBuffer());
  } else if (ext === "pptx") {
    r = await extractPptx(await file.arrayBuffer());
  } else if (ext === "docx") {
    r = await extractDocx(await file.arrayBuffer());
  } else if (ext === "ppt" || ext === "doc") {
    throw new Error(`${file.name}：古い形式（.${ext}）は読めません。.${ext}x で保存し直すか、PDFにしてください`);
  } else {
    throw new Error(`${file.name}：対応していない形式です（PDF / pptx / docx / txt / md）`);
  }
  const text = r.text.trim();
  if (!text) throw new Error(`${file.name}：文字を取り出せませんでした（画像だけのPDFなどは読めません）`);
  const truncated = text.length > MAX_CHARS_PER_FILE;
  const kept = truncated ? text.slice(0, MAX_CHARS_PER_FILE) : text;
  return {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: file.name,
    kind: ext,
    text: kept,
    chars: kept.length,
    count: r.count,
    unit: r.unit,
    truncated,
  };
}

/** 貼り付けたテキストを、ファイルと同じ形にする */
export function pastedMaterial(text, name = "貼り付けたメモ") {
  const t = text.trim();
  const truncated = t.length > MAX_CHARS_PER_FILE;
  const kept = truncated ? t.slice(0, MAX_CHARS_PER_FILE) : t;
  return { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, kind: "paste", text: kept, chars: kept.length, count: 1, unit: "テキスト", truncated };
}
