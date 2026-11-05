#!/usr/bin/env node
// Local stand-in for `vercel dev`, using only Node built-ins (no npm packages).
// Serves this folder as static files with Vercel's cleanUrls behaviour, and routes
// /api/break and /api/ai to the same handler files Vercel deploys.
//   cd sip-discovery-vercel && node dev.js        (PORT=3001 node dev.js to change the port)

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3001;
// Loopback only (this process holds your API key), but on BOTH stacks: browsers often
// resolve "localhost" to ::1 while curl picks 127.0.0.1, and binding just one lets another
// app hold the other and silently answer your requests.
const HOSTS = ["127.0.0.1", "::1"];

/* ---------- .env.local -> process.env (KEY=value lines) */
function loadEnv() {
  const file = path.join(ROOT, ".env.local");
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (e) { if (e.code === "ENOENT") return 0; throw e; }
  let n = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.length > 1 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val; // a real env var wins, like Vercel
    n++;
  }
  return n;
}
loadEnv();

/* ---------- static files */
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".woff2": "font/woff2",
};
const typeOf = p => TYPES[path.extname(p).toLowerCase()] || "application/octet-stream";

// never hand out env files, whatever the path looks like
const isSecret = p => path.basename(p).toLowerCase().startsWith(".env");

function resolveStatic(urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel.endsWith("/")) rel += "index.html";
  const abs = path.resolve(ROOT, "." + path.posix.normalize(rel));
  // stay inside the folder (blocks ../ traversal)
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  if (isSecret(abs)) return null;
  const ok = f => { try { return fs.statSync(f).isFile(); } catch { return false; } };
  if (ok(abs)) return abs;
  if (!path.extname(abs)) {                       // cleanUrls: /assistant -> assistant.html
    if (ok(abs + ".html")) return abs + ".html";
    if (ok(path.join(abs, "index.html"))) return path.join(abs, "index.html");
  }
  return null;
}

/* ---------- Vercel-style req/res helpers */
function decorate(req, res, raw) {
  res.status = code => { res.statusCode = code; return res; };
  res.json = obj => {
    if (!res.hasHeader("Content-Type")) res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = data => { res.end(data); return res; };
  // req.body parses lazily and throws on bad JSON, the way Vercel's parser does
  let cached = null;
  Object.defineProperty(req, "body", {
    configurable: true,
    get() {
      if (!cached) {
        try { cached = { value: raw.length ? JSON.parse(raw.toString("utf8")) : undefined }; }
        catch (err) { cached = { err }; }
      }
      if (cached.err) throw cached.err;
      return cached.value;
    },
  });
}

const readBody = req => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on("data", c => {
    size += c.length;
    if (size > 2 * 1024 * 1024) { reject(new Error("body too large")); req.destroy(); return; }
    chunks.push(c);
  });
  req.on("end", () => resolve(Buffer.concat(chunks)));
  req.on("error", reject);
});

const API = { "/api/break": "./api/break.js", "/api/ai": "./api/ai.js" };

/* ---------- server */
const handle = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const started = Date.now();
  res.on("finish", () => console.log(`${req.method} ${url.pathname} -> ${res.statusCode} (${Date.now() - started}ms)`));

  // --- API routes
  const route = API[pathname] || API[pathname.replace(/\.js$/, "")];
  if (route) {
    let raw = Buffer.alloc(0);
    try { if (req.method !== "GET" && req.method !== "HEAD") raw = await readBody(req); }
    catch {
      decorate(req, res, raw);
      return res.status(413).json({ code: "too_large", message: "Body too large." });
    }
    decorate(req, res, raw);
    try {
      const handler = require(route);
      await handler(req, res);
    } catch (err) {
      console.error(`  !! ${pathname}:`, err && err.message);
      if (!res.headersSent) res.status(500).json({ code: "upstream_error", message: "Something went wrong." });
      else res.end();
    }
    return;
  }

  // --- static
  if (req.method !== "GET" && req.method !== "HEAD") {
    decorate(req, res, Buffer.alloc(0));
    return res.status(405).json({ code: "invalid_request", message: "Method not allowed." });
  }
  const file = resolveStatic(pathname === "/" ? "/index.html" : pathname);
  if (!file) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end("<h1>404</h1><p>Not found. Try <a href=\"/\">/</a>, <a href=\"/assistant\">/assistant</a> or <a href=\"/lab\">/lab</a>.</p>");
  }
  const stat = fs.statSync(file);
  res.statusCode = 200;
  res.setHeader("Content-Type", typeOf(file));
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Cache-Control", "no-store"); // always serve the freshest build
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
};

/* ---------- listen on every loopback address, so "localhost" can't land elsewhere */
const listenOn = host => new Promise((resolve, reject) => {
  const s = http.createServer(handle);
  s.on("error", reject);
  s.listen(PORT, host, () => resolve(s));
});

(async () => {
  const live = [];
  for (const host of HOSTS) {
    try { live.push([host, await listenOn(host)]); }
    catch (err) {
      if (err.code === "EADDRINUSE") {
        console.error(`\n  Port ${PORT} is already taken on ${host} by another app.`);
        console.error(`  Free it, or start this server on a different port:\n      PORT=3002 node dev.js\n`);
        live.forEach(([, s]) => s.close());
        process.exit(1);
      }
      if (err.code === "EAFNOSUPPORT" || err.code === "EADDRNOTAVAIL") continue; // no IPv6 on this machine
      throw err;
    }
  }
  if (!live.length) { console.error("Could not bind any loopback address."); process.exit(1); }

  console.log(process.env.GROQ_API_KEY ? "GROQ_API_KEY loaded: live AI on" : "GROQ_API_KEY missing");
  console.log(`listening on ${live.map(([h]) => (h.includes(":") ? `[${h}]` : h) + ":" + PORT).join("  ")}`);
  console.log(`\n  Break Assistant   http://localhost:${PORT}/assistant`);
  console.log(`  Test lab          http://localhost:${PORT}/lab`);
  console.log(`  Discovery engine  http://localhost:${PORT}/`);
  console.log(`  API health        http://localhost:${PORT}/api/break\n`);
  console.log("Press Ctrl+C to stop.");
})();
