# Is my app safe to ship?

**What this page is for:** checking, in under a minute, whether an app made with AI has a security problem you should fix **before** you put it on the internet.

`codetac check` reads your project's code. It does not start your app, it needs no account, and it does not show the values of your secrets.

<video controls muted playsinline preload="none" poster="/video/demo-check.jpg" src="/video/demo-check.mp4" style="width:100%;border-radius:8px" aria-label="npx codetac check in a terminal: a .env file git would add, where the data goes, and what was checked and fine"></video>

## Steps

1. Open the Terminal in your project's folder: type `cd ` (with a space), drag the folder into the Terminal window, and press Enter.
2. Type:

   ```sh
   npx codetac check
   ```

   If codeTAC is already installed, `codetac check` does the same. **Node.js 20 or newer** is enough for this command ([how to check](/guide/get-started#what-you-need)).
3. Read the 🔴 first, then the 🟡. Each one says **what** was found, **why** it matters, and **where**: the file and the line.
4. Fix them (or ask your AI tool to fix them, pasting the line), and run the command again.

## What the answer looks like

A small app made with an AI tool (Vite, Supabase and OpenAI):

```txt
codeTAC check — my-app (vite-react)
6 files read in 0.1 s. Nothing was started; values in .env files are only classified (live or test, local or remote), never shown.

🔴 Do not ship like this (2)
  🔴 VITE_OPENAI_API_KEY has a secret's name but the framework's public prefix: its value goes into the code sent to the browser.
     Anyone who opens the app can read it in the code their browser downloads.
     at .env:3, src/main.jsx:11
  🔴 .env is followed by git: its values are in the repository's history.
     Anyone with a copy of the repository has these values, also in its old commits.
     at .env:1

🟡 Look at this (2)
  🟡 Table notes is used from the browser (src/main.jsx), and no SQL file of the project says whether its row level security is on.
     If it is off, anyone with the public key can read or change every row. Check it where the database is managed (in Supabase: Authentication → Policies).
     at src/main.jsx:4
  🟡 OpenAI is called from code that runs in the browser (src/main.jsx).
     Its key has to be in the browser too, where anyone can read it and use it on your account. Call it from your server.
     at src/main.jsx:9

ℹ Good to know (1)
  ℹ VITE_SUPABASE_URL in .env points to a Supabase project in the cloud, not a local one. …

📤 Where data goes (2 outside services)
  · OpenAI (ai), from the browser — src/main.jsx:9
  · Supabase (database), from the browser (address in VITE_SUPABASE_URL) — src/supabase.js:2

✅ Checked and fine (1)
  ✅ No key written in the code (Stripe, OpenAI, Anthropic, AWS, GitHub, Slack, Google, SendGrid, Supabase service_role, private keys).

Not ready to ship: 2 🔴 to fix first.
```

## What each finding means

### 🔴 Do not ship like this

| Finding | Why it matters |
| --- | --- |
| **A secret with a public prefix** (`NEXT_PUBLIC_`, `VITE_`…), read by the code | the build copies its value into the page every visitor downloads |
| **A `.env` file followed by git** | your secrets are in the repository, and stay in its history |
| **A key written in the code** (a live Stripe key, OpenAI, AWS…) | anyone who sees the code can use it |
| **A table with row level security off, used from the browser** | with the public key, which every visitor has, anyone can read or change every row |

### 🟡 Look at this

| Finding | Why it matters |
| --- | --- |
| **A table used from the browser whose row level security no SQL file shows** | common when tables are created in the Supabase dashboard: check it there |
| **An AI, email or message service called from the browser** | its key has to be in the browser too |
| **A secret with a public prefix that no code reads yet** | once some code reads it, it goes to the browser |
| **A secret read in browser code, without the prefix** | it is empty there, and adding the prefix would expose it |
| **A `.env` file git does not ignore** | the next `git add` publishes it |
| **A test key, or a Google key, written in the code** | a test key moves no real money; a Google key is sometimes public by design, but should be restricted |
| **Your local setup points to real things:** a live Stripe key, a database on another computer, `NODE_ENV=production` | what you test on your computer becomes real: real payments, real data |

### ℹ Good to know, 📤 Where data goes, ✅ Checked and fine

- **Good to know** is a fact that blocks nothing. Today, a Supabase project in the cloud used by your local setup.
- **Where data goes** lists every outside service the code sends data to, and whether the call leaves from the browser or from your server ([more](/guide/what-leaves-my-computer)).
- **Checked and fine** appears only when there was something to check. For example, “3 secret variables: none reaches the browser”.

## Your secret values are never shown

- To tell a live key from a test key, or a local database from a remote one, `check` reads your **development** `.env` files (`.env`, `.env.local`, `.env.development`).
- Each value is only **classified**. It is never printed, stored or sent anywhere: the report names the variable, the file and the line.
- `.env.production` and example files (`.env.example`) are not read, because their values are meant to be there.

## For CI and other tools

- **Exit code.** `codetac check` ends with **1** when there is a 🔴, else **0**: a CI job, or a git hook, can stop on it. With `--fail-on yellow` it also ends with 1 on a 🟡. A wrong option ends with 2.
- **`--json`** prints the same report for machines. Its shape is described in a [JSON Schema](https://deltaxmodules.github.io/codetacvibe/schema/check-report.v1.json): `verdict` (`red`, `yellow`, `clean` or `empty`), `counts`, `findings` with `places` (file and line), `info`, `passed` and `leaves`.

```sh
npx codetac check --json > check.json
npx codetac check --fail-on yellow
```

## What it can't tell you

- `check` **reads** the code: it does not see your database or your hosting settings. The Supabase dashboard decides whether row level security is on; `check` only knows what the project's SQL files say.
- **Keys written in the code** are recognised by known shapes only (Stripe, OpenAI, Anthropic, AWS, GitHub, Slack, Google, SendGrid, private keys, Supabase `service_role`). Other keys can slip by.
- **Indirect reads** of variables are not seen (`process.env[name]`, `@t3-oss/env`).
- A Postgres **view** used from the browser is reported like a table. For a view, what matters is whether it runs with its owner's rights.
- A key that was **already** pushed to GitHub stays in its history even after you remove the file: change the key at the service.
- More in [What codeTAC can't see](/guide/what-codetac-cant-see).
