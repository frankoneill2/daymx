DayMX – Daily Threads (Prototype)

Overview

- Mobile-first, browser-based SPA to manage threads, nested subthreads, reflection questions, and tasks.
- Two phases: Prepare (structure and inputs) and Review (Instagram Stories–style walkthrough).
- Data persists to localStorage only. No backend.

Run (Static)

- Open `index.html` in a modern browser (Chrome, Safari, Edge, Firefox).
- Best on mobile or a small window; fully client-side.

Run (Server + Database)

- Requirements: Node.js 18+.
- Start server: `npm start` (or `node server/server.js`)
- Visit: `http://localhost:5173` (served with an API)
- Data persistence:
  - The app will auto-detect the API at `/api/data` and persist to `server/db.json`.
  - If the API is not reachable, it falls back to localStorage.

Key Concepts

- Thread: Top-level category (e.g., Fitness, Reading).
- Subthread: Nested under any thread; each subthread can have Questions and Tasks.
- Question: Reflection or planning prompt. Editable in Prepare and addable during Review.
- Task: Action item tied to a subthread. Add in Prepare, mark complete and add during Review.

Prepare Phase

- Add threads (top-right of Threads section).
- For each thread/subthread:
  - Rename
  - + Subthread (nesting)
  - Questions (add/edit/remove)
  - Tasks (add/edit/remove)

Review Phase

- Press Start Review to step through subthreads sequentially.
- Top segmented progress bar shows your position.
- Each screen shows the subthread name, questions (with optional note fields), and tasks.
- You can:
  - Mark tasks complete
  - Add new tasks
  - Add new questions

Notes

- The review card note fields under questions are transient (not saved), intended for quick thoughts.
- By default, all nodes (threads and subthreads) appear in Review. If you prefer only leaf nodes, change `subthreadsForReview()` in `src/app.js` to filter by `n.children.length === 0`.

Deploying

- GitHub Pages continues to host the static app (no server runtime). For the API, deploy `server/server.js` separately (e.g., on a small VPS or Render/Fly/Heroku). Update CORS if hosting API on a different origin; by default it is permissive for development.
  - Alternatively, use Firebase Firestore directly from the client (recommended). See below.

Firebase (Firestore) Setup

- Create a Firebase project and a Web App; copy the config.
- Enable Firestore (Production mode). For a single shared public document, use rules:
  rules_version = '2';
  service cloud.firestore {
    match /databases/{database}/documents {
      // Low-stakes: public read/write to a single doc used by the app
      match /daymx/public {
        allow read, write: if true;
      }
    }
  }
- Note: This is intentionally open so your devices can sync without sign-in. Anyone who knows your project ID could modify this doc. For stronger protection, switch to Auth-based rules later.
- Edit `src/firebase-init.js` only if your Firebase config changes.
- The app auto-detects Firebase on load; otherwise falls back to localStorage.

License

- Prototype provided as-is for personal use and iteration.
