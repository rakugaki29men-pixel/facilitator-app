// 懇親会ファシリテーター：静的ファイル配信 + AI判断API
// APIキーはサーバー側だけで保持し、ブラウザには渡さない。
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.FACILITATOR_MODEL || "claude-opus-5-5";
// 会話の割り込み判断は速さ優先なので low。じっくり考えさせたいときは環境変数で上げる。
const EFFORT = process.env.FACILITATOR_EFFORT || "low";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

const client = new Anthropic();

// AIの返答フォーマット。speak=false のときは utterance は空文字。
const DECISION_SCHEMA = {
  type: "object",
  properties: {
    speak: { type: "boolean", description: "今、司会者として発言すべきか" },
    utterance: { type: "string", description: "読み上げるセリフ。speak=false なら空文字" },
    reason: { type: "string", description: "判断理由（幹事向けの短いメモ。読み上げない）" },
  },
  required: ["speak", "utterance", "reason"],
  additionalProperties: false,
};

async function decide({ system, user }) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    output_config: {
      effort: EFFORT,
      format: { type: "json_schema", schema: DECISION_SCHEMA },
    },
    messages: [{ role: "user", content: user }],
  });

  if (response.stop_reason === "refusal") {
    return { speak: false, utterance: "", reason: "AIが応答を辞退しました" };
  }
  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error(`テキスト応答がありません (stop_reason=${response.stop_reason})`);
  return JSON.parse(text);
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

async function handleDecide(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { error: "JSONが不正です" });
  }
  if (typeof body.system !== "string" || typeof body.user !== "string") {
    return sendJson(res, 400, { error: "system と user は文字列で指定してください" });
  }
  try {
    sendJson(res, 200, await decide(body));
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return sendJson(res, 500, { error: "APIキーが無効です（ANTHROPIC_API_KEY を確認）" });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return sendJson(res, 429, { error: "レート制限中です。少し待ってください" });
    }
    if (err instanceof Anthropic.APIError) {
      return sendJson(res, 502, { error: `API エラー: ${err.status} ${err.message}` });
    }
    console.error(err);
    sendJson(res, 500, { error: String(err.message || err) });
  }
}

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const filePath = path.join(PUBLIC_DIR, urlPath === "/" ? "index.html" : urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

http
  .createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/decide") return handleDecide(req, res);
    if (req.method === "GET") return serveStatic(req, res);
    res.writeHead(405).end();
  })
  .listen(PORT, () => {
    console.log(`ファシリテーター起動: http://localhost:${PORT}  (model=${MODEL}, effort=${EFFORT})`);
    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn("⚠ ANTHROPIC_API_KEY が設定されていません。AIの判断が失敗します。");
    }
  });
