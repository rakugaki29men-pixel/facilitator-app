// 懇親会ファシリテーター：静的ファイル配信 + AI判断API（OpenAI）
// OpenAIのAPIキーはサーバーの環境変数だけで持ち、ブラウザには渡さない。
// 他人にキーを使われないよう、APIには合言葉（FACILITATOR_PASSCODE）を必須にしている。
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const API_KEY = process.env.OPENAI_API_KEY;
const API_BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const PASSCODE = process.env.FACILITATOR_PASSCODE;
// 推論モデル（gpt-5系など）を使うときだけ設定する。非対応モデルに送ると400になるので未設定なら送らない
const REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT;

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

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

class UpstreamError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function decide({ system, user }) {
  const body = {
    model: MODEL,
    max_completion_tokens: 1000,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "facilitator_decision", strict: true, schema: DECISION_SCHEMA },
    },
  };
  if (REASONING_EFFORT) body.reasoning_effort = REASONING_EFFORT;

  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new UpstreamError(res.status, data.error?.message || `HTTP ${res.status}`);

  const choice = data.choices?.[0];
  if (choice?.message?.refusal) return { speak: false, utterance: "", reason: "AIが応答を辞退しました" };
  const text = choice?.message?.content;
  if (!text) throw new Error(`応答が空でした (finish_reason=${choice?.finish_reason})`);
  return JSON.parse(text);
}

// ---- 合言葉チェック（総当たり対策つき） ----
const failures = new Map(); // ip -> { count, resetAt }
const MAX_FAILURES = 10;
const WINDOW_MS = 10 * 60_000;

function clientIp(req) {
  // Render などのプロキシ越しなら X-Forwarded-For の先頭が実際のクライアント
  return (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
}

function passcodeMatches(given) {
  const a = crypto.createHash("sha256").update(String(given)).digest();
  const b = crypto.createHash("sha256").update(PASSCODE).digest();
  return crypto.timingSafeEqual(a, b);
}

// 戻り値: null なら通過。それ以外は返すエラー {status, error}
function checkAuth(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const rec = failures.get(ip);
  if (rec && rec.resetAt > now && rec.count >= MAX_FAILURES) {
    return { status: 429, error: "合言葉の間違いが続いたため、しばらく使えません。10分ほど待ってください" };
  }
  if (passcodeMatches(req.headers["x-passcode"] || "")) {
    failures.delete(ip);
    return null;
  }
  failures.set(ip, rec && rec.resetAt > now ? { ...rec, count: rec.count + 1 } : { count: 1, resetAt: now + WINDOW_MS });
  return { status: 401, error: "合言葉が違います" };
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 200_000) throw new Error("too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

async function handleDecide(req, res) {
  const denied = checkAuth(req);
  if (denied) return sendJson(res, denied.status, { error: denied.error });

  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { error: "リクエストが不正です" });
  }
  if (typeof body.system !== "string" || typeof body.user !== "string") {
    return sendJson(res, 400, { error: "system と user は文字列で指定してください" });
  }
  try {
    sendJson(res, 200, await decide(body));
  } catch (err) {
    if (err instanceof UpstreamError) {
      console.error(`OpenAI error ${err.status}: ${err.message}`);
      if (err.status === 401) return sendJson(res, 500, { error: "OpenAIのAPIキーが無効です（OPENAI_API_KEY を確認）" });
      if (err.status === 429) return sendJson(res, 429, { error: "OpenAIの利用制限に達しました（残高・上限額を確認）" });
      return sendJson(res, 502, { error: `OpenAIエラー: ${err.status} ${err.message}` });
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

const missing = ["OPENAI_API_KEY", "FACILITATOR_PASSCODE"].filter((k) => !process.env[k]);
if (missing.length) {
  // 合言葉なしで公開してしまうとキーを他人に使われるので、設定がなければ起動しない
  console.error(`環境変数が設定されていません: ${missing.join(", ")}`);
  process.exit(1);
}

http
  .createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/decide") return handleDecide(req, res);
    if (req.method === "GET") return serveStatic(req, res);
    res.writeHead(405).end();
  })
  .listen(PORT, () => {
    console.log(`ファシリテーター起動: http://localhost:${PORT}  (model=${MODEL})`);
  });
