# Changelog

## 0.10.0

**What did my last prompt change? Now also what the prompt asked for, and what your app does differently.**

- **Request:** in the report of a prompt, **Read the prompt with AI…** shows exactly what would be sent: the prompt with secrets hidden and the paths of the project's files, never code. It is sent only when you press **Send**. The AI writes the prompt as a list of changes (files, blocks that start depending on another, new services), marked as an interpretation; correct it with **Edit the request**, or **Write it yourself** with no AI. **The rules**, not the AI, compare that list with what changed:
  - **You asked, and it was done**;
  - **The AI also did**: what the prompt did not ask for, counted as **outside the request** in the report, the history, `codetac diff` and the bar (`↗ 2`);
  - **Asked, not done**.
- New Privacy kind `requests` (on request only; **No AI** turns it off).
- **Behavior (observed):** run an action in your app before a prompt and the same action again after it. The report compares the two runs:
  - the requests to the server and how they answered, the functions of your project that ran, what the action did outside the code (database, outside services, AI, email, payments, files) and its errors;
  - for example: «button “Add user”» now also sends an email (Resend);
  - **Show its path on the map** colours the action's path: new on the path, no longer on it, through code the prompt changed, unchanged;
  - actions run only after the prompt are listed apart, because there is no point of comparison. Nothing is run again for you. Node and Python apps.
- `codetac diff` prints the Request and the Behavior too.
- **Fix:** a service whose name already says its category no longer repeats it in the sentences («SMTP (email, from …)», not «SMTP (email) (email, from …)»).
- **Fix:** a request to the AI with the paths of a large project is no longer cut at 10 KB without a word.

## 0.9.0

**What did my last prompt change? A report for each prompt you give Claude Code, with no snapshot by hand.**

- **`codetac hooks install`** adds three Claude Code hooks to `.claude/settings.local.json` (it shows them and asks first; nothing else is written in the project). From then on, each prompt is recorded: its text, with secrets hidden, and the project's files when it starts and when it ends, kept in `~/.codetac/diff/`, never in the project. `.env` files keep only the variable names, and keys written in the code are masked. `codetac hooks uninstall` puts the file back as it was; `codetac hooks status` says whether they are installed.
- **The bar of your app** shows **Prompt running…** while a prompt runs, then **What changed?** with the number of changes and, in orange, the number to look at.
- **The report of a prompt** (from the bar, or `codetac diff --open` with no app running):
  - sentences made by rules, the most important first, in **Look at these** and **Flow and data**, each with its proof;
  - new risks: a dependency added, removed or with another version (`package.json`, `requirements*.txt`, `pyproject.toml`), a test file deleted, a file with fewer tests, a new route *possibly* without a session check;
  - the **Map**: the plan before and after the prompt;
  - the **code**: old lines beside new ones, each block with the sentences it explains, and how many blocks no sentence explains;
  - press a sentence to light its lines and boxes; press a box to light its sentences;
  - **◀ previous prompt**, **next prompt ▶** and **History**, with what you have not opened yet.
- **In the terminal:** `codetac diff [n]` (files, structure, risks), `--code` (the lines), `--list` (the prompts recorded).
- Interrupted prompts (Esc) and subagents still working when the next prompt starts are handled: the report says when changes may be mixed.
- The 50 newest prompts are kept for each project (`diff.keep` in `codetac.structure.json`).
- The view **Changes** can compare against a prompt (**before prompt N**).
- **Fix:** a sentence about a secret could end in "(—)" when no file was listed, and a line could be given twice as proof.
- New page in the manual: *What did my last prompt change?*

## 0.8.1

**Fixes from trying codeTAC on five real open-source projects (Next.js, Express, Flask, FastAPI, React + FastAPI).**

- **Routes:** Express routers mounted in a chain (`export default Router().use('/api', api)`) keep their prefix; a FastAPI `include_router(prefix=settings.API_V1_STR)` reads the prefix from the settings' default value (and says so when it cannot); the pages of a frontend router (`src/routes` used only in the browser) are Interface, not Routes.
- **A frontend with a generated API client** (hey-api `client.post({ url })`, openapi-typescript-codegen `__request(OpenAPI, …)`) is linked to the Python routes, so the path of an action goes from the button to the API.
- **Data model:** Alembic tables created in helper functions called by `upgrade()`; `WITH … INSERT` is a write (the CTE names are not tables, and subqueries are reads, not writes).
- **Services:** calls made in tests no longer add services; `PrismaClient` gives the database of the schema; Flask-Mail, `emails` and Elasticsearch are recognised.
- **Secrets:** a key that is public by design keeps being public when its name ends with the environment (`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_LIVE` is no longer "a secret with a public prefix").
- **Fewer false "unused" warnings:** generated code (a generated header or `*.gen.*`) gets no warnings; `FLASK_APP`, `prisma.seed`, `*.preset.js` and React Email templates are used; components copied by shadcn/ui (the `ui` folder of `components.json`) are only "possibly" unused; a Python module loaded by name is only "possibly" unused.
- **Starting the app:**
  - Prisma 4, 5 or 6.0 without `previewFeatures = ["tracing"]` now gets a warning (at the start and in `codetac diagnose`): its database operations would otherwise be missing from the dossiers without a word.
  - When the API's port is taken and the API moves, the frontend's `.env` variables with that address (`VITE_API_URL=http://localhost:8000`) follow it while codeTAC runs; the file does not change.
  - `--port` works for a Python app whose start command codeTAC builds.
  - A start script that needs a program this computer does not have (`bun`) is said before starting, with the parts that start without it; exit code 127 is no longer retried in minimal mode.
- **Fix:** a dossier with a function that only ran database commands without a table (a connection pool reset) failed to open.
- **Fix:** in Python apps, the bar showed internal names ("structure", "structureTitle") instead of its texts.
- Every sentence of the interface (terminal, panel, bar, requests to the AI) is now in one file, `src/structure/text/en.json`, ready for translation. Nothing shown has changed.

## 0.8.0

**The structure of Python projects: FastAPI and Flask, and a Node frontend with a Python API as one plan.**

- **Python projects get the plan:** files by block, functions (with the same names the Python dossier uses, so the path of an action lights them), routes of FastAPI (`@app.get`, `APIRouter(prefix=…)`, `include_router`, `Depends`) and Flask (`@app.route(…, methods=…)`, Blueprints, `register_blueprint`, app factories), and every view of Structure: What leaves the machine, Secrets and variables, Data model, Structure health, Changes, Quiz.
- The Python files are read by a small helper that ships with codeTAC and uses only Python's standard library: it reads the syntax and never imports or runs your code. Any Python 3.8 or newer does (the project's `.venv` first, else `python3`; `CODETAC_PYTHON` to choose). Only changed files are read again. Without Python, the files are listed and the plan says why.
- **Data model in Python:** SQLAlchemy models (SQLModel too), Alembic migrations and `CREATE TABLE` in `execute(…)`; who reads and writes each table (`session.query`, `Model.query`, `select`, `add`, `delete`, SQL in `execute`).
- **Services and variables in Python:** `requests`, `httpx`, `urllib` and the Python SDKs of the catalogue (a `python` entry per service, also in `codetac.structure.json`); `os.environ`, `os.getenv` and pydantic-settings `BaseSettings` fields; a SQLAlchemy engine is the database service.
- **A Node frontend and a Python API are one plan:** the page's `fetch('/api/…')` points to the Python routes, and the path of an action goes from the button to the Python functions.
- The number of changes not opened now shows on the bar of Python apps too.
- `codetac structure --suggest` now sends the public names of Python files (`class Cache; def normalise`), not "exports nothing".
- **Fix:** in a folder outside git (or without a `.gitignore`), virtual environments (`.venv`, any folder with a `pyvenv.cfg`), `__pycache__` and the caches of pytest, mypy and ruff were listed as files of the project. They are left out now, also when committed.
- The graph's tables can have `source` `sqlalchemy` or `alembic` (schema version unchanged).
- **Fix:** a start command that does not exist (`codetac -- python …` on a Mac, where it is `python3`) made `codetac` stop with an error trace. It now says “Could not start "python": the command was not found”, once, without retrying in minimal mode.

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
