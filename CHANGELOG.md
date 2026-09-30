# Changelog

## 0.7.0

**What changed in the structure, and learning it: compare versions, predict, quiz, and control what goes to the AI.**

- **Changed — read this if you use Anthropic, OpenAI or another model outside your computer:** with an AI model that is **not on this computer**, the automatic purpose sentences of the dossiers are now **off by default** (they carry code and are sent in the background). Turn them on in Privacy (`codetac privacy --on purposes`). With a local model (Ollama) nothing changes.
- **Snapshots of the structure:** `codetac structure --snapshot [label]` saves the project's structure as it is now (named by the commit, or by a hash of the files when there are changes not committed or no git), and `--snapshots` lists them. Kept in `~/.codetac/structure/snapshots/`, never in the project (the graph compressed: about 1 MB for a project of 10 000 files); the newest 20 per project (`snapshots.keep` in `codetac.structure.json`). Git is only read.
- **What changed in the structure:** `codetac structure --diff [snapshot]` compares the project with a snapshot and says it in sentences made by rules (no AI): new external services and who sends them data, new import loops, secrets that now reach the browser, tables with row level security off used from the browser, blocks that now depend on others, tables, columns, routes, variables and files added, removed or changed — the most important first, each with its proof, marked when it touches leaks or secrets. A line added at the top of a file, or a file moved, is not reported as functions removed and added.
- **Changes** (a new view of Structure): the plan with what was added, removed or changed since a snapshot marked on it (removed files keep their box), the sentences above it with their proofs, a filter for leaks and secrets, a picker of snapshots and **Save a snapshot now**. Press a sentence to see it on the plan.
- **Compare two commits** (or a commit and now): `codetac structure --diff HEAD~3 HEAD`, and the latest commits in the Changes view. The commit is read from a temporary copy made with `git archive`, removed at the end — no checkout, no worktree: the working folder and `.git` are never touched. Without git, snapshots do the same.
- **Explain the plan, and each alert, with AI** (optional): five lines about the whole project, and an explanation under every alert of Secrets, Data model, Structure health and Changes. Only facts of the structure are sent (never code, never values); you see the exact request first; an answer naming something outside the facts is rejected; the answer is marked as written by AI.
- **Predict before you ask:** in the Changes view, **Predict…** lets you write what you expect the change you are about to ask the AI for to do — files added, changed or removed, blocks that start depending on another, new external services (chosen from the project's lists or written) — and saves it with a snapshot. After the change, the view says what you got right, what changed that you did not predict, and what you predicted that did not change. Rules only, no AI; the prediction is kept beside the snapshot, never in the project. In the terminal: `codetac structure --snapshot [label] --predict`, then `--diff`.
- **Quiz** (a new view of Structure): multiple-choice questions about your own project — which block writes to a table, which file sends data to a service, which block another depends on, where a route is defined, which variable a file reads. Questions, answers and the other choices all come from the plan, by rules (no AI); each answer is checked again against the plan before it is asked, and comes with its proof. **New questions** asks others. Your results are kept on this machine only (`~/.codetac/structure/quiz/`).
- **Changes you have not opened yet:** the number of structural changes since the newest snapshot that you have not opened in the Changes view is on the **Changes** button and on the **Structure** pill of the bar in your app. Opening a sentence marks it as seen and the number goes down; changes not opened before you save a new snapshot are carried over and listed until you open them. Kept on this machine only (`~/.codetac/structure/review/`), never sent to the AI.
- **Privacy** (a new screen of the panel, and `codetac privacy` in the terminal): every kind of request CodeTAC can make to an AI model — purpose sentences, questions about a step, suggestions for Unknown files, explanations — with what it carries, a switch for each and a global **No AI**. The choice counts at once in the panel and in the terminal. Every request sent is written to a log on this computer (`~/.codetac/ai-log.jsonl`), shown on the screen with its exact text.
- **Questions about a step now show the exact request first**, and send it only after **Send** (what is sent is what you saw). `codetac structure --suggest` also shows the fixed instructions sent with the files.
- **Fix:** a command whose output is cut short (`codetac structure --diff | head`) now stops quietly instead of ending with an `EPIPE` error.

## 0.6.0

**The data model, and the structure's health.**

- **Data model** (a new view of Structure): the project's tables from Prisma, Drizzle, SQL migrations or Supabase's generated types, and the tables known only from their use in the code (`supabase.from('t')`, SQL in `query(…)`, Prisma and Drizzle calls). A diagram with zoom (columns, keys, links between tables) and the card of each table: who reads and who writes it, by operation, with the file, block and line; where it is defined; its row level security (on or off, and the number of policies, from the SQL files).
- **Alert** for a table with row level security off that the browser reads or writes directly; **warnings** for a table used but not defined, and one defined but never used.
- **Structure health** (a new view): import loops, browser code skipping the server, too many links, copied code, files nothing uses, large files and exports nothing imports — each with why it matters, its proof and a link to the plan. Framework entry points are never called dead; when in doubt it says “possibly”, and why. Limits and kinds turned off in `codetac.structure.json` (`smells`). Nothing blocks.
- `codetac structure` also lists the tables, their problems and a summary of the structure's health.
- The graph gains optional fields (schema version unchanged): `source`, `columns` and `rls` on tables; `operations` on reads/writes; `names` on imports; `exportedAs` on symbols; `path` on notes, and notes of kind `dynamic-import`.
- **Fix:** a new `codetac` no longer reuses a panel of an older version left running (the Structure tab answered `{"error":"Not found."}` when a 0.3.x panel was still open). It starts its own panel on the next free port and says how to close the old one. The panel now tells its version on `/api/ping`.

## 0.5.0

**What leaves the machine, and where the secrets are.**

- **What leaves the machine** (a new view of Structure): every service the code sends data to, with where it is called, browser or server, the destination (the address, the variable it comes from, or unknown — never guessed) and the jurisdiction you wrote for it; plus what the session saw going out: calls and the names of the fields sent (never values), and hosts the code as read does not show.
- A catalogue of about 50 known services (AI, databases, payments, email, messaging, analytics, monitoring, storage, auth), read from `fetch`/axios/ky calls and from their SDKs (`createClient`, `new Stripe(…)`, `Sentry.init(…)`…). Extend it, and set jurisdictions, in `codetac.structure.json` (`services`).
- **Secrets and variables** (a new view): every environment variable, where it is defined (by name only) and read; alerts for a secret with a public prefix, a `.env` followed by git and a key written in the code; warnings for a secret read in the browser and a `.env` not covered by `.gitignore`; lists of variables defined but never used, and used but never defined (`env.platform` in the configuration for those set by the hosting platform).
- Secret values are never shown, stored or sent: keys written in the code are masked in every code excerpt, also in the dossier's code view.
- The recording keeps the names of the fields each `fetch` sends to another host (never the values).
- The graph's notes can carry a `kind` (schema version unchanged).

## 0.4.0

**Structure: the floor plan of the whole project**, next to the dossier of each action.

- **Structure** button in the bar, and an Action / Structure tab in the sheet. The plan shows the project's files in blocks and layers (Interface, Routes and API, Logic, Data access, External integrations; utilities, configuration, tests and unknown files apart), with the imports and calls between them. Blocks open into files, files into functions and routes. Search by name.
- Read from the code, without running it: Next.js (App Router, `pages/api`, Server Actions), Express, Fastify, Vite + React, plain Node; monorepos and workspaces; TypeScript path aliases; `fetch`/`axios` calls to the project's own routes.
- **The card of a block:** what it is for, who uses it, what it uses, the data it touches, its largest files, its entry points. Every line opens the file and line that prove it. Optional AI explanation: it shows first exactly what is sent (the facts, never code) and rejects an explanation that names something not in them.
- **The path of an action on the plan:** after an action, what it went through is lit and the rest dimmed; arrows seen only at run time are drawn apart. «See on plan» on each step of the dossier; «Actions that pass here» on the card; «What never ran» over the session.
- **Follows your changes:** a saved file is read again and the plan redrawn within a few seconds.
- `codetac structure [folder]`: the blocks as text; `--reclassify <file> <block|auto>` to place a file yourself; `--suggest` to ask the AI about Unknown files (preview first).
- Optional `codetac.structure.json` at the project root: `ignore`, `layers` (your own rules), `reclassify`. Written by you; codeTAC only writes it when you reclassify a file.
- Recommended project size: up to 10 000 files (0.8 s the first time, 0.3 s after that).
- The Structure sentences live in `src/structure/text/en.json`, ready for translation.
- New runtime dependency: `@babel/parser`.

Also from 0.3.3 (already published): MongoDB, Prisma (native engine), AI tokens over `http`/axios, postgres.js and Redis boundaries.

What the static reading does not see is listed in the README, section 5.
