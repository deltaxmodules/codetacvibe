# Changelog

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
