// 設定と資料を、別の端末へ移す（スマホで準備して、当日のPCで使うため）。
// 設定・資料はブラウザごとに保存されるので、端末をまたぐときはファイルかテキストで持っていく。
// 合言葉は含めない（移した先で入力する）。
import { STORAGE_KEY } from "./settings.js";
import { loadMaterials, saveMaterials } from "./materials.js";

export function buildBackup(settings, { includeMaterials = true } = {}) {
  const data = { app: "facilitator-app", version: 1, exportedAt: new Date().toISOString(), settings };
  if (includeMaterials) data.materials = loadMaterials();
  return JSON.stringify(data);
}

export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("読み込めません（バックアップの形式が正しくありません）");
  }
  if (data?.app !== "facilitator-app" || typeof data.settings !== "object" || data.settings === null) {
    throw new Error("このアプリのバックアップではありません");
  }
  return data;
}

/** @returns {{materials:number}} 読み込んだ資料の数 */
export function applyBackup(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data.settings));
  let materials = 0;
  if (data.materials && typeof data.materials === "object") {
    if (!saveMaterials(data.materials)) throw new Error("資料を保存できませんでした（ブラウザの保存容量が足りません）");
    materials = Object.values(data.materials).reduce((n, files) => n + files.length, 0);
  }
  return { materials };
}

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

/** 設定画面の下に出す「引き継ぎ」の部品 */
export function renderTransfer(root, settings) {
  const withMaterials = h("input", { type: "checkbox", checked: true });
  const message = h("p", { className: "hint", hidden: true });
  const say = (text) => {
    message.textContent = text;
    message.hidden = !text;
  };
  const paste = h("textarea", { rows: 3, placeholder: "コピーしたバックアップを、ここに貼り付けて「読み込む」" });
  const current = () => buildBackup(settings, { includeMaterials: withMaterials.checked });

  const download = h("button", {
    type: "button",
    textContent: "📤 ファイルに書き出す",
    onclick: () => {
      const url = URL.createObjectURL(new Blob([current()], { type: "application/json" }));
      const a = h("a", { href: url, download: "facilitator-backup.json" });
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      say("書き出しました。別の端末に移して、そちらで「読み込む」を押してください。");
    },
  });
  const copy = h("button", {
    type: "button",
    textContent: "📋 コピーする",
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(current());
        say("コピーしました。別の端末の「貼り付け」欄に貼り付けてください。");
      } catch {
        paste.value = current(); // コピーできないときは、欄に出して手でコピーしてもらう
        paste.select();
        say("自動でコピーできなかったので、下の欄に出しました。全部選んでコピーしてください。");
      }
    },
  });

  const apply = (text) => {
    try {
      const data = parseBackup(text);
      if (!confirm("この端末の設定（と資料）を、バックアップの内容で置き換えます。よろしいですか？")) return;
      const { materials } = applyBackup(data);
      alert(`読み込みました${materials ? `（資料${materials}件）` : ""}。画面を読み込み直します。`);
      location.reload();
    } catch (err) {
      say(err.message);
    }
  };
  const file = h("input", {
    type: "file",
    accept: ".json,application/json",
    onchange: async (e) => {
      const f = e.target.files[0];
      e.target.value = "";
      if (f) apply(await f.text());
    },
  });

  root.replaceChildren(
    h(
      "details",
      { className: "section" },
      h("summary", {}, "引き継ぎ（別の端末へ設定・資料を移す）"),
      h("div", { className: "section-body" },
        h("p", { className: "hint" }, "設定と資料は、この端末のブラウザにだけ保存されています。当日使う端末が別なら、ここで移してください（合言葉は含まれません）。"),
        h("label", { className: "check" }, withMaterials, "資料も含める"),
        h("div", { className: "chips" }, download, copy),
        h("label", { className: "field" }, h("span", {}, "ファイルから読み込む"), file),
        h("label", { className: "field" }, h("span", {}, "貼り付けから読み込む"), paste),
        h("button", { type: "button", textContent: "📥 貼り付けた内容を読み込む", onclick: () => apply(paste.value) }),
        message,
      ),
    ),
  );
}
