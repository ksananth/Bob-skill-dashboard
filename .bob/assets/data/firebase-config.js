// Firebase settings, shared by the dashboard (index.html) and the Bob hook (skills.js).
// Copy them from Firebase Console -> Project settings -> Your apps -> Web app (</>).
// The apiKey is not a secret: it only says which project to talk to. firestore.rules protects the data.
const BOB_FIREBASE = {
  apiKey: "YOUR_API_KEY",
  projectId: "YOUR_PROJECT_ID",
};

if (typeof module !== "undefined") module.exports = BOB_FIREBASE;   // Node (skills.js)
else window.BOB_FIREBASE = BOB_FIREBASE;                           // browser (index.html)
