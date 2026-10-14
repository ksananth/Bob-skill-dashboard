# Bob-skill-dashboard

Dashboard of Bob skills with live usage counts and last-used time, stored in Firestore.

## Setup (once)

1. **Firebase config:** in Firebase Console → Project settings → Your apps → Web app, copy `apiKey` and `projectId` into `.bob/assets/data/firebase-config.js`.
2. **Security rules:** paste `firestore.rules` into Firestore → Rules → Publish. They only allow "+1 to count, last used = now", so nobody can set fake numbers.
3. **Test:** `node .bob/assets/tools/skills.js log compose-screen` should print "Recorded 1 use", and the dashboard updates instantly.

Needs Node 18+ (uses built-in `fetch`, nothing to `npm install`).

## How it works

- Bob's `PostToolUse` hook on `use_skill` runs `skills.js log`, which adds 1 to `skills/<skill-name>.count` and sets `lastUsedAt` in Firestore.
- `index.html` lists the skills from `assets/data/skills-data.js` (built from each `SKILL.md`) and gets the counts live from Firestore.
- If a write fails, Bob is never blocked; the reason goes to `.bob/assets/data/firestore-errors.log`.
