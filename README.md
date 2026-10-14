# Bob-skill-dashboard

Dashboard of Bob skills with live usage counts and last-used time, stored in Firestore.

## Setup (once)

1. **Firebase config:** fill in `apiKey` and `projectId` in `.bob/assets/data/skills-firebase-db-config.js` (from Firebase Console → Project settings → Your apps → Web app). Then run `git update-index --skip-worktree .bob/assets/data/skills-firebase-db-config.js` once, so your key is never committed.
2. **Security rules:** in Firebase Console → Firestore Database → **Rules**, replace everything with the rules below (also in `firestore.rules`) and click **Publish**. Without them, Firestore blocks every write with `403 Missing or insufficient permissions`.
3. **Test:** `node .bob/assets/tools/track-skill-usage.js compose-screen` should print "Recorded 1 use", and the dashboard updates instantly.

Needs Node 18+ (uses built-in `fetch`, nothing to `npm install`).

## Firestore security rules

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /skills/{skill} {
      allow read: if true;
      allow create: if request.resource.data.keys().hasOnly(['count', 'lastUsedAt'])
                    && request.resource.data.count == 1
                    && request.resource.data.lastUsedAt == request.time;
      allow update: if request.resource.data.keys().hasOnly(['count', 'lastUsedAt'])
                    && request.resource.data.count == resource.data.count + 1
                    && request.resource.data.lastUsedAt == request.time;
      allow delete: if false;
    }
  }
}
```


## Opening the dashboard

Double-click `.bob/index.html` in **Chrome or Edge**. The first time, click **Choose skills folder** and pick `.bob/skills` (the `.bob` folder or the repo root also work). The browser remembers it; if it asks again, click **Allow** (tick "Allow on every visit" if offered). The folder button at the top changes it.

## How it works

- Bob's `PostToolUse` hook on `use_skill` runs `track-skill-usage.js`, which adds 1 to `skills/<skill-folder>.count` and sets `lastUsedAt` in Firestore.
- Counts are saved under the skill's **folder name**. Changing the `name:` line in a SKILL.md keeps the same count; renaming the folder starts a new one.
- `index.html` reads every `SKILL.md` directly each time it opens (and every few seconds), and gets the counts live from Firestore. Nothing is generated, so there's nothing to commit when skills change.
- If a write fails, Bob is never blocked; the reason goes to `.bob/assets/data/firestore-errors.log`.
