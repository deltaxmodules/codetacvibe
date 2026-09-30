# Glossary

Words you will see in codeTAC, in plain English.

**Action**
: One thing you do in your app: a click, a form sent, a page opened. Each action gets a dossier.

**Alert / warning**
: An **alert** is something to fix (for example a secret that reaches the browser). A **warning** is something worth a look. Neither stops your app.

**Block**
: A group of files on the floor plan with the same job: Interface, Routes and API, Logic, Data access, External integrations, and so on.

**Boundary (outside service)**
: A moment when your app talks to the outside world: the database, an email service, payments, an AI model, any outside address. Shown as coloured tags in the dossier.

**Browser / server**
: The **browser** is the page your user sees; everything that runs there can be read by anyone. The **server** is the part of your app that runs on your (or your host's) computer, out of sight.

**Dossier**
: The record of one action: what was clicked, which of your functions ran, which outside services were used, and what remained afterwards.

**`.env` file**
: A file with your app's settings and keys (`DATABASE_URL=…`). It should never go to GitHub.

**Floor plan (the plan)**
: The map of your whole project that **Structure** draws from the code: its files in blocks, and the arrows between them.

**Jurisdiction**
: Where (which country or region) a service keeps the data you send it. You write it; codeTAC never guesses it.

**Lasting effect**
: What remained after an action: rows written, emails sent, cookies set.

**Minimal mode**
: When codeTAC cannot follow your functions, it still shows requests, outside services and the browser. A yellow strip says why.

**Panel**
: The page, on your computer only, where codeTAC shows the dossiers (`http://127.0.0.1:4000` by default).

**Row level security (RLS)**
: A database rule (common in Supabase) that decides which rows each user may read or change. With it **off**, anyone with the public key can read or change the whole table.

**Route**
: An address your server answers, such as `POST /api/items`.

**Secret**
: A value that must stay private: a password, an API key, a token. codeTAC shows secrets by **name** only, never their value.

**Snapshot**
: A saved copy of your project's structure at one moment, used to see what changed later. Kept on your computer, outside the project.

**Structure**
: The part of codeTAC that reads your code (without running it) and draws the floor plan, with its views: What leaves the machine, Secrets and variables, Data model, Structure health, Changes, Quiz.

**Unknown**
: The block for files codeTAC could not place. You can place them yourself with `--reclassify`.
