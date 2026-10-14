#!/usr/bin/env node
// =============================================================================
// track-skill-usage.js
//
// Counts how often each Bob skill is used, in Firestore.
// Every time Bob uses a skill, this adds 1 to that skill and saves the time.
//
// Firestore data (one document per skill, named after the skill's FOLDER):
//
//     skills/compose-screen  ->  { count: 12, lastUsedAt: <time> }
//
// How it runs:
//   Automatically - .bob/settings.json runs it after every "use_skill" call.
//   By hand (to test) - node .bob/assets/tools/track-skill-usage.js compose-screen
//
// If anything goes wrong, Bob is never blocked; the reason is written to
// .bob/assets/data/firestore-errors.log
// =============================================================================

const fs = require("fs");
const path = require("path");
const os = require("os");

// ---------- Where things are --------------------------------------------------

const BOB_FOLDER = path.resolve(__dirname, "..", "..");
const FIREBASE_CONFIG_FILE = path.join(BOB_FOLDER, "assets", "data", "skills-firebase-db-config.js");
const ERROR_LOG_FILE = path.join(BOB_FOLDER, "assets", "data", "firestore-errors.log");
const UNMATCHED_LOG_FILE = path.join(BOB_FOLDER, "assets", "data", "unmatched.log");

// Folders that can hold skills. If two have the same skill, the first one wins
// (project skills override global ones, like Bob does).
const SKILL_FOLDERS = [
  path.join(BOB_FOLDER, "skills"),                   // this project's skills
  path.join(process.cwd(), ".bob", "skills"),        // same, when run from the repo root
  path.join(os.homedir(), ".bob", "skills"),         // your global skills
];

// ---------- Step 1: work out which skill was used -----------------------------

// Reads the "name:" line from the top of a SKILL.md, e.g. "name: compose-screen".
function readSkillName(skillMdText) {
  const header = skillMdText.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!header) return null;
  const nameLine = header[1].match(/^name:\s*["']?(.+?)["']?\s*$/m);
  return nameLine ? nameLine[1] : null;
}

// Builds a lookup: any name Bob might use (folder name or "name:" line) -> folder name.
// The folder name is what we save in Firestore, so renaming "name:" keeps the same count.
function buildNameToFolderLookup() {
  const lookup = {};
  for (const skillsFolder of SKILL_FOLDERS) {
    let folders = [];
    try { folders = fs.readdirSync(skillsFolder, { withFileTypes: true }); } catch { continue; }

    for (const folder of folders) {
      if (!folder.isDirectory()) continue;
      const folderName = folder.name;

      let skillMd;
      try { skillMd = fs.readFileSync(path.join(skillsFolder, folderName, "SKILL.md"), "utf8"); } catch { continue; }

      const nameInFile = readSkillName(skillMd) || folderName;
      for (const name of [folderName, nameInFile]) {
        const key = name.toLowerCase();
        if (!(key in lookup)) lookup[key] = folderName;
      }
    }
  }
  return lookup;
}

// Turns whatever name Bob gave into the skill's folder name.
// If no skill matches, keeps the name as it is.
function toFolderName(nameFromBob) {
  const name = nameFromBob.trim();
  return buildNameToFolderLookup()[name.toLowerCase()] || name;
}

// Bob sends the hook a JSON message on stdin, like { "input": { "skill": "compose-screen" } }.
// The exact field name isn't documented, so try the likely ones.
function skillNameFromBobMessage(message) {
  const input = JSON.parse(message || "{}").input || {};
  const lookup = buildNameToFolderLookup();

  const likelyField = ["skill", "skill_name", "skillName", "name"]
    .map((field) => input[field])
    .find((value) => typeof value === "string" && value.trim());
  if (likelyField) return likelyField;

  // Otherwise, any value that matches a known skill.
  return Object.values(input).find((value) => typeof value === "string" && lookup[value.trim().toLowerCase()]) || null;
}

// ---------- Step 2: save +1 in Firestore --------------------------------------

function loadFirebaseConfig() {
  let config = null;
  try { config = require(FIREBASE_CONFIG_FILE); } catch {}
  const isFilledIn = config && config.apiKey && config.projectId && !/^YOUR_/.test(config.apiKey + config.projectId);
  if (!isFilledIn) throw new Error("Firebase isn't set up yet: fill in " + FIREBASE_CONFIG_FILE);
  return config;
}

// One write that does both: count + 1, and lastUsedAt = Firebase's current time.
// Creates the document the first time a skill is used.
// Uses Firestore's web API with Node's built-in fetch, so nothing to npm install.
async function addOneUse(folderName) {
  const { apiKey, projectId } = loadFirebaseConfig();
  const database = `projects/${projectId}/databases/(default)/documents`;
  const url = `https://firestore.googleapis.com/v1/${database}:commit?key=${encodeURIComponent(apiKey)}`;

  const request = {
    writes: [{
      transform: {
        document: `${database}/skills/${folderName}`,
        fieldTransforms: [
          { fieldPath: "count", increment: { integerValue: "1" } },
          { fieldPath: "lastUsedAt", setToServerValue: "REQUEST_TIME" },
        ],
      },
    }],
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    const details = (await response.text()).slice(0, 300);
    throw new Error(`Firestore said ${response.status}: ${details}`);
  }
}

// ---------- Run ---------------------------------------------------------------

const runByHand = process.stdout.isTTY;

async function track(nameFromBob) {
  if (!nameFromBob || nameFromBob.includes("/")) return;
  const folderName = toFolderName(nameFromBob);
  try {
    await addOneUse(folderName);
    if (runByHand) console.log(`Recorded 1 use of "${folderName}" in Firestore`);
  } catch (error) {
    try { fs.appendFileSync(ERROR_LOG_FILE, `${new Date().toISOString()} ${error.message}\n`); } catch {}
    if (runByHand) console.error(error.message);
  }
}

function readBobMessageAndTrack() {
  let message = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (message += chunk));
  process.stdin.on("end", () => {
    let name = null;
    try { name = skillNameFromBobMessage(message); } catch {}
    if (name) return track(name);
    try { fs.appendFileSync(UNMATCHED_LOG_FILE, message + "\n"); } catch {}   // to see what Bob sent
  });
}

const skillGivenByHand = process.argv[2];
if (skillGivenByHand) track(skillGivenByHand);
else readBobMessageAndTrack();
