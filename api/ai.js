// Vercel serverless function: live AI for the Test and Ask views when the page is not opened inside claude.ai.
// The browser sends only task inputs; prompts are built here from lib/prompts.js, so this endpoint can't be
// used as a general-purpose chatbot on the site owner's key. The key lives in the GROQ_API_KEY env variable.
const D = require("../data.json");
const makePrompts = require("../lib/prompts.js");

const P = makePrompts(D);
const BY_ID = new Map(D.corpus.map(e => [e.id, e]));
const MODELS = (process.env.GROQ_MODELS || "openai/gpt-oss-120b,openai/gpt-oss-20b").split(",").map(s => s.trim()).filter(Boolean);
const LIMIT = Number(process.env.RATE_LIMIT_PER_10_MIN || 20);
const recent = new Map(); // ip -> request timestamps (per warm instance; a light guard, not a hard quota)

function rateLimited(ip) {
  const now = Date.now(), list = (recent.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  list.push(now); recent.set(ip, list);
  return list.length > LIMIT;
}

function buildPrompt(body) {
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 3000) : "";
  switch (body.task) {
    case "tag":
      if (text.length < 15) throw { status: 400, code: "invalid_request", message: "Text is too short." };
      return P.codePrompt(text, String(body.src || "other").slice(0, 20), String(body.plat || "").slice(0, 30));
    case "verify":
      if (text.length < 15) throw { status: 400, code: "invalid_request", message: "Text is too short." };
      return P.verifyPrompt(text);
    case "ask": {
      const q = typeof body.question === "string" ? body.question.trim().slice(0, 300) : "";
      const hits = (Array.isArray(body.ids) ? body.ids : []).slice(0, 30).map(id => BY_ID.get(String(id))).filter(Boolean);
      if (q.length < 5 || !hits.length) throw { status: 400, code: "invalid_request", message: "A question and matching posts are required." };
      return P.askPrompt(q, hits);
    }
    default:
      throw { status: 400, code: "invalid_request", message: "Unknown task." };
  }
}

function parseJson(content) {
  try { return JSON.parse(content); } catch {}
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) try { return JSON.parse(fence[1]); } catch {}
  const s = content.indexOf("{"), e = content.lastIndexOf("}");
  if (s >= 0 && e > s) try { return JSON.parse(content.slice(s, e + 1)); } catch {}
  throw { status: 502, code: "invalid_json", message: "The model's reply wasn't valid JSON." };
}

async function callGroq(prompt) {
  let lastErr = { status: 502, code: "upstream_error", message: "No model answered." };
  for (const model of MODELS) {
    const payload = { model, temperature: 0, response_format: { type: "json_object" }, max_completion_tokens: 3000,
                      messages: [{ role: "user", content: prompt }] };
    if (model.includes("gpt-oss")) payload.reasoning_effort = "low";
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST", headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (r.ok) {
      const j = await r.json();
      return { result: parseJson(j.choices?.[0]?.message?.content || ""), model };
    }
    const errText = await r.text();
    lastErr = r.status === 429 ? { status: 429, code: "rate_limited", message: "The AI provider's usage limit was reached. Try again later." }
                               : { status: 502, code: r.status === 400 && errText.includes("json") ? "invalid_json" : "upstream_error", message: `Provider error ${r.status}` };
    if (r.status !== 429 && r.status < 500 && !errText.includes("json_validate_failed")) break; // a real request error: don't try other models
  }
  throw lastErr;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") return res.status(200).json({ ok: !!process.env.GROQ_API_KEY, provider: "Groq" });
  if (req.method !== "POST") return res.status(405).json({ code: "invalid_request", message: "Use POST." });
  if (!process.env.GROQ_API_KEY) return res.status(503).json({ code: "sampling_disabled", message: "The site owner hasn't configured an AI key." });
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  if (rateLimited(ip)) return res.status(429).json({ code: "rate_limited", message: "Too many requests. Wait a few minutes." });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { result, model } = await callGroq(buildPrompt(body));
    return res.status(200).json({ result, model });
  } catch (e) {
    return res.status(e.status || 500).json({ code: e.code || "upstream_error", message: e.message || "Something went wrong." });
  }
};
