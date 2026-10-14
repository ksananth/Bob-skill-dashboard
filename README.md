# Bob-skill-dashboard

Dashboard of Bob skills with live usage counts and last-used time, stored in Firestore.

## Setup (once)

1. **Firebase config:** fill in `apiKey` and `projectId` in `.bob/assets/data/skills-firebase-db-config.js` (from Firebase Console → Project settings → Your apps → Web app). Then run `git update-index --skip-worktree .bob/assets/data/skills-firebase-db-config.js` once, so your key is never committed.
2. **Security rules:** paste `firestore.rules` into Firestore → Rules → Publish. They only allow "+1 to count, last used = now", so nobody can set fake numbers.
3. **Test:** `node .bob/assets/tools/track-skill-usage.js compose-screen` should print "Recorded 1 use", and the dashboard updates instantly.

Needs Node 18+ (uses built-in `fetch`, nothing to `npm install`).

## Opening the dashboard

Double-click `.bob/index.html` in **Chrome or Edge**. The first time, click **Choose skills folder** and pick `.bob/skills` (the `.bob` folder or the repo root also work). The browser remembers it; if it asks again, click **Allow** (tick "Allow on every visit" if offered). The folder button at the top changes it.

## How it works

- Bob's `PostToolUse` hook on `use_skill` runs `track-skill-usage.js`, which adds 1 to `skills/<skill-name>.count` and sets `lastUsedAt` in Firestore.
- `index.html` reads every `SKILL.md` directly each time it opens (and every few seconds), and gets the counts live from Firestore. Nothing is generated, so there's nothing to commit when skills change.
- If a write fails, Bob is never blocked; the reason goes to `.bob/assets/data/firestore-errors.log`.
