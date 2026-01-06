DayMX – Daily Threads (Prototype)

Overview

- Mobile-first, browser-based SPA to manage threads, nested subthreads, reflection questions, and tasks.
- Two phases: Prepare (structure and inputs) and Review (Instagram Stories–style walkthrough).
- Data persists to localStorage only. No backend.

Run

- Open `index.html` in a modern browser (Chrome, Safari, Edge, Firefox).
- Best on mobile or a small window; fully client-side.

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

License

- Prototype provided as-is for personal use and iteration.

