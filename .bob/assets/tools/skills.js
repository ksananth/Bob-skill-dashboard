#!/usr/bin/env node
// Bob skills — one script, two jobs (both run by the hooks in .bob/settings.json).
//
//   node .bob/assets/tools/skills.js log     After each use_skill: adds 1 to that skill in skills-usage.json, then builds.
//   node .bob/assets/tools/skills.js build   On session start (or by hand): writes assets/data/skills-data.js.
//
// skills-usage.json  ->  { "<skill-name>": <count> }   the counts (edit or set to {} to reset, then run build)
// skills-data.js     ->  the same counts + each SKILL.md, as a script, because browsers won't let a
//                        double-clicked index.html read .json files but will load .js files.
const fs = require("fs");
const path = require("path");

const BOB = path.resolve(__dirname, "..", "..");                     // the .bob folder
const SKILLS_DIR = path.join(BOB, "skills");
const USAGE_FILE = path.join(BOB, "assets", "data", "skills-usage.json");
const DATA_FILE = path.join(BOB, "assets", "data", "skills-data.js");

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
      build();
    } catch {}                                                        // never block Bob
  });
}

/* ---------- build ---------- */
function build() {
  let usage = {};
  try { usage = JSON.parse(fs.readFileSync(USAGE_FILE, "utf8")) || {}; } catch {}
  const skills = listSkills().map((s) => ({ ...s, count: Number(usage[s.id]) || 0 }));
  fs.writeFileSync(DATA_FILE, "// Generated from skills-usage.json and the SKILL.md files by skills.js - do not edit\n" +
    "window.BOB_SKILLS = " + JSON.stringify(skills) + ";\n");
}

const cmd = process.argv[2];
if (cmd === "log") log();
else { build(); if (process.stdout.isTTY) console.log("Updated assets/data/skills-data.js"); }
