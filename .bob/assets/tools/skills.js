#!/usr/bin/env node
// Bob skills — one script for everything.
//
//   node .bob/assets/tools/skills.js log      Hook: Bob pipes the use_skill call on stdin; adds 1 to that skill's count.
//   node .bob/assets/tools/skills.js start    Hook: starts the viewer in the background if it isn't running (prints nothing).
//   node .bob/assets/tools/skills.js serve    Runs the viewer in this terminal and opens http://localhost:4173.
//
// Data: assets/data/skills-usage.json  ->  { "<skill-name>": <count>, ... }   (edit or empty it to reset)
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, exec } = require("child_process");

const BOB = path.resolve(__dirname, "..", "..");                     // the .bob folder
const SKILLS_DIR = path.join(BOB, "skills");
const USAGE_FILE = path.join(BOB, "assets", "data", "skills-usage.json");
const PORT = Number(process.env.BOB_SKILLS_PORT) || 4173;

/* ---------- skills ---------- */
function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const meta = {};
  if (!m) return meta;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
    else v = v.replace(/^["']|["']$/g, "");
    meta[kv[1]] = v;
  }
  return meta;
}

function listSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((d) => {
    let text;
    try { text = fs.readFileSync(path.join(SKILLS_DIR, d.name, "SKILL.md"), "utf8"); } catch { return []; }
    const m = frontmatter(text);
    return [{
      id: d.name,
      name: m.name || d.name,
      description: m.description || "",
      category: m.category || "Uncategorised",
      tags: Array.isArray(m.tags) ? m.tags : m.tags ? [m.tags] : [],
      path: `skills/${d.name}/SKILL.md`,
      body: text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim(),
    }];
  });
}

/* ---------- log (PostToolUse hook on use_skill) ---------- */
function log() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    try {
      const input = (JSON.parse(raw || "{}").input) || {};
      // Bob doesn't document use_skill's parameter name, so try the likely ones, then any value matching a skill.
      const names = {};
      for (const s of listSkills()) { names[s.id.toLowerCase()] = s.id; names[s.name.toLowerCase()] = s.id; }
      let found = ["skill", "skill_name", "skillName", "name"].map((k) => input[k]).find((v) => typeof v === "string" && v.trim());
      if (!found) found = Object.values(input).find((v) => typeof v === "string" && names[v.trim().toLowerCase()]);
      if (!found) {
        fs.appendFileSync(path.join(BOB, "assets", "data", "unmatched.log"), raw + "\n");
        return;
      }
      const id = names[found.trim().toLowerCase()] || found.trim();
      let usage = {};
      try { usage = JSON.parse(fs.readFileSync(USAGE_FILE, "utf8")); } catch {}
      usage[id] = (Number(usage[id]) || 0) + 1;
      fs.writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2) + "\n");
    } catch {}                                                        // never block Bob
  });
}

/* ---------- serve (the viewer) ---------- */
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

function serve(openBrowser) {
  const server = http.createServer((req, res) => {
    const send = (code, body, type = "text/plain", extra = {}) => {
      res.writeHead(code, { "Content-Type": type + "; charset=utf-8", "Cache-Control": "no-store", ...extra });
      res.end(body);
    };
    let p;
    try { p = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { return send(400, "Bad request"); }
    if (p === "/api/ping") return send(200, '{"app":"bob-skills"}', "application/json", { "Access-Control-Allow-Origin": "*" });
    if (p === "/api/skills") return send(200, JSON.stringify(listSkills()), "application/json");
    if (p === "/") p = "/index.html";
    const file = path.resolve(BOB, "." + p);
    if (!file.startsWith(BOB + path.sep) || /settings\.json$/i.test(file)) return send(404, "Not found");
    fs.readFile(file, (err, data) => {
      if (err) return send(404, "Not found");
      res.writeHead(200, { "Content-Type": (TYPES[path.extname(file)] || "application/octet-stream") + "; charset=utf-8", "Cache-Control": "no-store" });
      res.end(data);
    });
  });
  server.on("error", (e) => {
    console.error(e.code === "EADDRINUSE" ? `Already running: http://localhost:${PORT}` : e.message);
    process.exit(1);
  });
  server.listen(PORT, "127.0.0.1", () => {
    const url = `http://localhost:${PORT}`;
    if (!openBrowser) return;
    console.log(`Bob skills: ${url}   (Ctrl+C to stop)`);
    exec(process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`, () => {});
  });
}

/* ---------- start (SessionStart hook) ---------- */
function start() {
  const req = http.get({ host: "127.0.0.1", port: PORT, path: "/api/ping", timeout: 800 }, () => process.exit(0)); // already running
  const launch = () => {
    spawn(process.execPath, [__filename, "serve-quiet"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    process.exit(0);
  };
  req.on("timeout", () => { req.destroy(); launch(); });
  req.on("error", launch);
}

const cmd = process.argv[2];
if (cmd === "log") log();
else if (cmd === "start") start();
else if (cmd === "serve-quiet") serve(false);
else serve(true);
