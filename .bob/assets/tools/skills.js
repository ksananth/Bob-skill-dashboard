#!/usr/bin/env node
// Bob skills — one script, run by the hooks in .bob/settings.json.
//
//   node .bob/assets/tools/skills.js log           After each use_skill: adds 1 to that skill in Firestore and sets its last-used time.
//   node .bob/assets/tools/skills.js log <skill>   Same, by hand (handy to test the Firestore setup).
//   node .bob/assets/tools/skills.js start         On session start: builds, and starts the watcher in the background if needed.
//   node .bob/assets/tools/skills.js build         Rebuilds assets/data/skills-data.js now (also run on every prompt).
//   node .bob/assets/tools/skills.js watch         Watches skills/ and rebuilds on any change.
//
// Firestore          ->  skills/<skill-name> = { count, lastUsedAt }   the usage numbers, shared by everyone
// skills-data.js     ->  the list of skills (each SKILL.md), as a script, because browsers won't let a
//                        double-clicked index.html list folders, but will load .js files.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const BOB = path.resolve(__dirname, "..", "..");                     // the .bob folder
// Where skills can live (first match of a name wins, like Bob: project skills override global ones).
const SKILL_DIRS = [...new Set([
  path.join(BOB, "skills"),                          // index.html sits inside .bob
  path.join(BOB, ".bob", "skills"),                  // index.html sits in the repo root
  path.join(process.cwd(), ".bob", "skills"),        // hooks run from the repo root
  path.join(os.homedir(), ".bob", "skills"),         // Bob's global skills
])];
const DATA_FILE = path.join(BOB, "assets", "data", "skills-data.js");
const PID_FILE = path.join(BOB, "assets", "data", "watcher.pid");
const CONFIG_FILE = path.join(BOB, "assets", "data", "firebase-config.js");
const ERROR_LOG = path.join(BOB, "assets", "data", "firestore-errors.log");

/* ---------- skills ---------- */
function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const meta = {};
  if (!m) return meta;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v === "" || /^[>|][+-]?$/.test(v)) {                 // multi-line value (YAML > or |, or indented lines)
      const more = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) more.push(lines[++i].trim());
      if (more.length && more.every((l) => l.startsWith("- "))) { meta[kv[1]] = more.map((l) => l.slice(2).trim()); continue; }
      v = more.join(" ");
    }
    if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
    else v = v.replace(/^["']|["']$/g, "");
    meta[kv[1]] = v;
  }
  return meta;
}

function listSkills() {
  const seen = new Set();
  const out = [];
  for (const dir of SKILL_DIRS) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    const global = dir === path.join(os.homedir(), ".bob", "skills");
    for (const d of entries) {
      if (!d.isDirectory() || seen.has(d.name)) continue;
      let text;
      try { text = fs.readFileSync(path.join(dir, d.name, "SKILL.md"), "utf8"); } catch { continue; }
      const m = frontmatter(text);
      if (!m.description) continue;                         // Bob ignores skills without a description too
      seen.add(d.name);
      out.push({
        id: d.name,
        name: m.name || d.name,
        description: m.description,
        category: m.category || (global ? "Global" : "Uncategorised"),
        tags: Array.isArray(m.tags) ? m.tags : m.tags ? String(m.tags).split(",").map((t) => t.trim()).filter(Boolean) : [],
        path: (global ? "~/.bob/skills/" : "skills/") + d.name + "/SKILL.md",
        body: text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim(),
      });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/* ---------- Firestore ---------- */
function firebaseConfig() {
  try {
    delete require.cache[CONFIG_FILE];
    const c = require(CONFIG_FILE);
    if (c && c.apiKey && c.projectId && !/^YOUR_/.test(c.apiKey + c.projectId)) return c;
  } catch {}
  throw new Error("Firebase isn't set up yet: fill in " + path.relative(process.cwd(), CONFIG_FILE));
}

// One atomic write: count + 1 and lastUsedAt = the server's time. Creates the document on first use.
// Uses the REST API with Node's built-in fetch, so there's nothing to npm install.
async function recordUse(id) {
  const c = firebaseConfig();
  const db = `projects/${c.projectId}/databases/(default)/documents`;
  const res = await fetch(`https://firestore.googleapis.com/v1/${db}:commit?key=${encodeURIComponent(c.apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      writes: [{
        transform: {
          document: `${db}/skills/${id}`,
          fieldTransforms: [
            { fieldPath: "count", increment: { integerValue: "1" } },
            { fieldPath: "lastUsedAt", setToServerValue: "REQUEST_TIME" },
          ],
        },
      }],
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Firestore said ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

function logError(err) {
  try { fs.appendFileSync(ERROR_LOG, `${new Date().toISOString()} ${err.message || err}\n`); } catch {}
}

/* ---------- log (PostToolUse hook on use_skill) ---------- */
function skillFromInput(raw) {
  const input = (JSON.parse(raw || "{}").input) || {};
  // Bob doesn't document use_skill's parameter name, so try the likely ones, then any value matching a skill.
  const names = {};
  for (const s of listSkills()) { names[s.id.toLowerCase()] = s.id; names[s.name.toLowerCase()] = s.id; }
  let found = ["skill", "skill_name", "skillName", "name"].map((k) => input[k]).find((v) => typeof v === "string" && v.trim());
  if (!found) found = Object.values(input).find((v) => typeof v === "string" && names[v.trim().toLowerCase()]);
  if (!found) {
    fs.appendFileSync(path.join(BOB, "assets", "data", "unmatched.log"), raw + "\n");
    return null;
  }
  return names[found.trim().toLowerCase()] || found.trim();
}

async function track(id) {
  if (!id || /[\/]/.test(id)) return;
  try {
    await recordUse(id);
    if (process.stdout.isTTY) console.log(`Recorded 1 use of "${id}" in Firestore`);
  } catch (err) {
    logError(err);                                                   // never block Bob
    if (process.stdout.isTTY) console.error(err.message);
  }
}

function log(manual) {
  if (manual) return track(manual.trim());
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    let id = null;
    try { id = skillFromInput(raw); } catch {}
    if (id) track(id);
  });
}

/* ---------- build ---------- */
function build() {
  // Write only when something changed, so the watcher doesn't react to its own output.
  const skills = listSkills();
  const out = "// Generated from the SKILL.md files by skills.js - do not edit. Usage counts live in Firestore.\n" +
    "window.BOB_SKILLS = " + JSON.stringify(skills) + ";\n";
  let old = "";
  try { old = fs.readFileSync(DATA_FILE, "utf8"); } catch {}
  if (out !== old) fs.writeFileSync(DATA_FILE, out);
  return skills.length;
}

/* ---------- watch (keeps skills-data.js live) ---------- */
function watcherRunning() {
  try { process.kill(Number(fs.readFileSync(PID_FILE, "utf8")), 0); return true; } catch { return false; }
}

function watch() {
  fs.writeFileSync(PID_FILE, String(process.pid));
  const cleanup = () => { try { if (fs.readFileSync(PID_FILE, "utf8") === String(process.pid)) fs.unlinkSync(PID_FILE); } catch {} process.exit(0); };
  process.on("SIGINT", cleanup); process.on("SIGTERM", cleanup);

  let timer = null;
  const rebuild = () => { clearTimeout(timer); timer = setTimeout(() => { try { build(); } catch {} }, 300); };
  const watched = new Map();
  const watchDir = (dir) => {
    if (watched.has(dir) || !fs.existsSync(dir)) return;
    try {
      const w = fs.watch(dir, { recursive: true }, rebuild);       // recursive: Windows, macOS, Node 20+ on Linux
      w.on("error", () => { watched.delete(dir); });
      watched.set(dir, w);
    } catch {}
  };
  const watchAll = () => { SKILL_DIRS.forEach(watchDir); };
  watchAll();
  setInterval(() => { watchAll(); rebuild(); }, 30000);             // pick up a skills/ folder created later; safety rebuild
  build();
  if (process.stdout.isTTY) console.log("Watching skills for changes (Ctrl+C to stop)");
}

function start() {
  build();
  if (!watcherRunning()) {
    spawn(process.execPath, [__filename, "watch"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  }
}

const cmd = process.argv[2];
if (cmd === "log") log(process.argv[3]);
else if (cmd === "start") start();
else if (cmd === "watch") watch();
else {
  const n = build();
  if (process.stdout.isTTY) console.log(n ? `Found ${n} skills -> assets/data/skills-data.js` : "No skills found. Looked in:\n  " + SKILL_DIRS.join("\n  "));
}
