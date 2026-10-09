#!/usr/bin/env node
// Bob skills helper.
//   node .bob/assets/tools/skills.js use <skill>    -> log one use by hand (same as the hook does)
//   node .bob/assets/tools/skills.js reset          -> set every count to 0 and clear the event log
//   node .bob/assets/tools/skills.js list           -> print skills with their counts
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");            // the .bob folder
const SKILLS_DIR = path.join(ROOT, "skills");
const DATA = path.join(ROOT, "assets", "data");
const USAGE_FILE = path.join(DATA, "skills-usage.json");
const EVENTS_FILE = path.join(DATA, "skill-events.json");

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2) + "\n");

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const meta = {};
  if (!m) return meta;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1, -1).split(",").map(s => s.trim()).filter(Boolean);
    else v = v.replace(/^["']|["']$/g, "");
    meta[kv[1]] = v;
  }
  return meta;
}

function scan() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      const file = path.join(SKILLS_DIR, d.name, "SKILL.md");
      if (!fs.existsSync(file)) return null;
      const text = fs.readFileSync(file, "utf8");
      const meta = parseFrontmatter(text);
      return {
        id: d.name,
        name: meta.name || d.name,
        description: meta.description || "",
        category: meta.category || "Uncategorised",
        tags: Array.isArray(meta.tags) ? meta.tags : (meta.tags ? [meta.tags] : []),
        path: `skills/${d.name}/SKILL.md`,
        body: text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim(),
      };
    })
    .filter(Boolean);
}

module.exports = { scan };

if (require.main === module) {
  const [cmd = "list", arg] = process.argv.slice(2);
  if (cmd === "use") {
    if (!arg) { console.error("Usage: node .bob/assets/tools/skills.js use <skill-name>"); process.exit(1); }
    if (!scan().some(s => s.id === arg)) { console.error(`No skill folder named "${arg}" in .bob/skills`); process.exit(1); }
    const now = new Date();
    const u = readJson(USAGE_FILE, {});
    u[arg] = { count: ((u[arg] && u[arg].count) || 0) + 1, lastUsed: now.toISOString().slice(0, 10) };
    writeJson(USAGE_FILE, u);
    const ev = readJson(EVENTS_FILE, []);
    ev.push({ skill: arg, at: now.toISOString(), session: "manual" });
    writeJson(EVENTS_FILE, ev);
    console.log(`${arg}: ${u[arg].count} uses`);
  } else if (cmd === "reset") {
    const u = {};
    for (const s of scan()) u[s.id] = { count: 0, lastUsed: null };
    writeJson(USAGE_FILE, u);
    writeJson(EVENTS_FILE, []);
    console.log("All counts set to 0 and event log cleared.");
  } else {
    const u = readJson(USAGE_FILE, {});
    const rows = scan().map(s => [s.id, (u[s.id] && u[s.id].count) || 0]).sort((a, b) => b[1] - a[1]);
    for (const [id, n] of rows) console.log(String(n).padStart(5) + "  " + id);
  }
}
