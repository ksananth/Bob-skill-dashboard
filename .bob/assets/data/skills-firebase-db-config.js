// Firebase settings, shared by the dashboard (index.html) and the Bob hook (track-skill-usage.js).
//
// SETUP: fill in your values below. They come from
// Firebase Console -> Project settings -> Your apps -> Web app (</>).
//
// Keep your key out of git: after filling it in, run this once in the repo folder
//     git update-index --skip-worktree .bob/assets/data/skills-firebase-db-config.js
// so git ignores your local changes to this file.
const BOB_FIREBASE = {
  apiKey: "YOUR_API_KEY",
  projectId: "YOUR_PROJECT_ID",
};

if (typeof module !== "undefined") module.exports = BOB_FIREBASE;   // Node (track-skill-usage.js)
else window.BOB_FIREBASE = BOB_FIREBASE;                           // browser (index.html)
