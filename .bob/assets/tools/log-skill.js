#!/usr/bin/env node
// Bob PostToolUse hook: records every skill activation (tool "use_skill").
// Bob pipes JSON on stdin: { event, session_id, tool, input: {...}, output }
// Writes:
//   assets/data/skills-usage.json  -> { "<skill>": { count, lastUsed } }
//   assets/data/skill-events.json  -> [ { skill, at, session } ... ] (newest last, capped)
// The skills page (index.html) reads these two files directly.
// Never blocks Bob: always exits 0.
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");                  // .bob
const DATA = path.join(ROOT, "assets", "data");
const SKILLS_DIR = path.join(ROOT, "skills");
const USAGE_FILE = path.join(DATA, "skills-usage.json");
const EVENTS_FILE = path.join(DATA, "skill-events.json");
const DEBUG_FILE = path.join(DATA, "hook-debug.log");
const MAX_EVENTS = 5000;

function readJson(f, fallback) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; } }
function writeJson(f, v) { const tmp = f + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + "\n"); fs.renameSync(tmp, f); }
function debug(msg, raw) {
  try { fs.appendFileSync(DEBUG_FILE, `${new Date().toISOString()} ${msg}\n${raw || ""}\n\n`); } catch {}
}

// Map both folder names and frontmatter "name:" values to the folder id.
function knownSkills() {
  const map = {};
  try {
    for (const d of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      map[d.name.toLowerCase()] = d.name;
      try {
        const m = fs.readFileSync(path.join(SKILLS_DIR, d.name, "SKILL.md"), "utf8").match(/^---[\s\S]*?\nname:\s*["']?([^"'\r\n]+)/);
        if (m) map[m[1].trim().toLowerCase()] = d.name;
      } catch {}
    }
  } catch {}
  return map;
}

// Bob doesn't document use_skill's parameter name, so try the likely ones, then any string value.
function findSkill(input, known) {
  if (!input) return null;
  if (typeof input === "string") return input;
  for (const k of ["skill", "skill_name", "skillName", "name", "id"]) {
    if (typeof input[k] === "string" && input[k].trim()) return input[k].trim();
  }
  for (const v of Object.values(input)) {
    if (typeof v === "string" && known[v.trim().toLowerCase()]) return v.trim();
  }
  return null;
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try {
    const p = JSON.parse(raw || "{}");
    if (p.tool && p.tool !== "use_skill") return;              // matcher should already filter this
    const known = knownSkills();
    const found = findSkill(p.input, known);
    if (!found) { debug("Could not find a skill name in payload:", raw); return; }
    const id = known[found.toLowerCase()] || found;            // global/unknown skills are logged under their own name

    const now = new Date();
    const usage = readJson(USAGE_FILE, {});
    usage[id] = { count: ((usage[id] && usage[id].count) || 0) + 1, lastUsed: now.toISOString().slice(0, 10) };
    writeJson(USAGE_FILE, usage);

    const events = readJson(EVENTS_FILE, []);
    events.push({ skill: id, at: now.toISOString(), session: p.session_id || null });
    writeJson(EVENTS_FILE, events.slice(-MAX_EVENTS));

  } catch (e) {
    debug("Hook error: " + e.message, raw);
  }
});
