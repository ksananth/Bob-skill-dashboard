#!/usr/bin/env node
// Local viewer for the Bob skills page.
//   node .bob/assets/tools/serve.js            -> http://localhost:4173 (opens your browser)
//   node .bob/assets/tools/serve.js --port 5000 --no-open
// Serves the .bob folder read-only, plus GET /api/skills = [{ id, text }] for each skills/<id>/SKILL.md.
// The page reads assets/data/skills-usage.json and assets/data/skill-events.json directly.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");      // .bob
const SKILLS_DIR = path.join(ROOT, "skills");
const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf("--port") + 1]) || Number(process.env.PORT) || 4173;
const OPEN = !args.includes("--no-open");

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};

function send(res, code, body, type = "text/plain; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function listSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      try { return { id: d.name, text: fs.readFileSync(path.join(SKILLS_DIR, d.name, "SKILL.md"), "utf8") }; }
      catch { return null; }
    })
    .filter(Boolean);
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { return send(res, 400, "Bad request"); }

  if (urlPath === "/api/skills") return send(res, 200, JSON.stringify(listSkills()), TYPES[".json"]);
  if (urlPath === "/") urlPath = "/index.html";

  const file = path.resolve(ROOT, "." + urlPath);
  if (!file.startsWith(ROOT + path.sep)) return send(res, 403, "Forbidden");          // no escaping .bob
  if (/[\\/](settings\.json|hook-debug\.log)$/i.test(file)) return send(res, 404, "Not found");
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, "Not found");
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") console.error(`Port ${PORT} is busy. Try: node .bob/assets/tools/serve.js --port ${PORT + 1}`);
  else console.error(e.message);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Bob skills: ${url}   (Ctrl+C to stop)`);
  if (OPEN) {
    const cmd = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }
});
