// Vercel serverless function for the Break Assistant MVP.
// Flow: redact personal data -> AI reads the message (intent, months, language, reply) -> gate checks the reply
// -> plan of options built by code from Groww's own rules. If the AI fails or the gate fails, a safe default
// reply is used and the plan is still shown, so the person is never left without options.
const B = require("../lib/break.js");

const MODELS = (process.env.GROQ_MODELS || "openai/gpt-oss-120b,openai/gpt-oss-20b").split(",").map(s => s.trim()).filter(Boolean);
const LIMIT = Number(process.env.RATE_LIMIT_PER_10_MIN || 20);
const recent = new Map();
const rateLimited = ip => {
  const now = Date.now(), list = (recent.get(ip) || []).filter(t => now - t < 600000);
  list.push(now); recent.set(ip, list); return list.length > LIMIT;
};

function parseJson(s) {
  try { return JSON.parse(s); } catch {}
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) try { return JSON.parse(s.slice(a, b + 1)); } catch {}
  return null;
}

async function askModel(prompt) {
  if (!process.env.GROQ_API_KEY) return { error: "no_key" };
  let last = "upstream_error";
  for (const model of MODELS) {
    const payload = { model, temperature: 0, response_format: { type: "json_object" }, max_completion_tokens: 1200,
                      messages: [{ role: "user", content: prompt }] };
    if (model.includes("gpt-oss")) payload.reasoning_effort = "low";
    try {
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST", headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (r.ok) { const j = await r.json(); const out = parseJson(j.choices?.[0]?.message?.content || ""); if (out) return { out, model }; last = "invalid_json"; continue; }
      last = r.status === 429 ? "rate_limited" : "upstream_error";
    } catch { last = "upstream_error"; }
  }
  return { error: last };
}

// Everything except the model call, so evals can run the exact same logic.
async function respond(body, ask = askModel, today) {
  const action = ["skip", "change", "cancel"].includes(body.action) ? body.action : "skip";
  const state = B.normState(body.state && typeof body.state === "object" ? body.state : {});
  const raw = typeof body.text === "string" ? body.text : "";
  const { text: clean, removed } = B.redact(raw.slice(0, 1000));
  const text = clean.trim(), lang = B.detectLang(text);
  const base = { action, state, lang, removedPII: removed, truncated: raw.length > 1000 };

  if (text.length < 3) {
    return { ...base, mode: "no_text", intent: "unclear", months: null, message: B.NO_TEXT[lang],
             gate: { passed: true, checks: [] }, plan: B.plan({ action, intent: "unclear", months: null, state, today }) };
  }
  const res = await ask(B.prompt(text, action, state, lang));
  if (res.error) {
    // AI unavailable: rule-based reading, safe default reply, same plan logic
    const intent = B.basicIntent(text, action), months = B.basicMonths(text);
    return { ...base, mode: "basic", aiError: res.error, intent, months,
             message: intent === "fund_advice" ? B.DECLINE[lang] : B.FALLBACK[lang],
             gate: { passed: true, checks: [] }, plan: B.plan({ action, intent, months, state, today }) };
  }
  const ai = res.out;
  if (Number.isFinite(ai.months_needed) && !Number.isInteger(ai.months_needed)) ai.months_needed = Math.ceil(ai.months_needed);
  const g = B.gate(ai, { text, lang, state });
  const intent = B.INTENTS.includes(ai.intent) ? ai.intent : B.basicIntent(text, action);
  const months = Number.isInteger(ai.months_needed) && ai.months_needed >= 1 && ai.months_needed <= 24 ? ai.months_needed : null;
  const message = g.passed ? ai.message.trim() : (intent === "fund_advice" ? B.DECLINE[lang] : B.FALLBACK[lang]);
  return { ...base, mode: g.passed ? "ai" : "ai_gated", model: res.model, intent, months,
           hardship: !!ai.hardship, clarify: typeof ai.clarify === "string" && ai.clarify.trim() ? ai.clarify.trim() : null,
           message, rawMessage: g.passed ? undefined : ai.message, cited: Array.isArray(ai.cited_rules) ? ai.cited_rules.filter(r => B.RULES[r]) : [],
           gate: g, plan: B.plan({ action, intent, months, state, today }) };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") return res.status(200).json({ ok: !!process.env.GROQ_API_KEY, provider: "Groq" });
  if (req.method !== "POST") return res.status(405).json({ code: "invalid_request", message: "Use POST." });
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  if (rateLimited(ip)) return res.status(429).json({ code: "rate_limited", message: "Too many requests. Wait a few minutes." });
  let body;
  try { body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}); }
  catch { return res.status(400).json({ code: "invalid_request", message: "Send JSON: {text, action, state}." }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return res.status(400).json({ code: "invalid_request", message: "Send JSON: {text, action, state}." });
  try {
    return res.status(200).json(await respond(body));
  } catch (e) {
    return res.status(500).json({ code: "upstream_error", message: "Something went wrong." });
  }
};
module.exports.respond = respond;
module.exports.askModel = askModel;
