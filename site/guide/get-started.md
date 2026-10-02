# Install and first dossier

**What this page is for:** getting codeTAC running on your app and seeing your first **dossier** — the record of one action — in about five minutes.

## What you need

1. **Node.js 24 or newer.** Open the Terminal and type `node -v`. It must show `v24` or a higher number. If it does not, install the LTS version from [nodejs.org](https://nodejs.org). You need Node even if your app is in Python: codeTAC itself is installed with npm.
2. **Your app's project on your computer.** If your app lives in Lovable, Bolt, v0 or Replit, connect it to GitHub first, then download it:
   - on GitHub, press **Code → Download ZIP** and unzip the file;
   - or, if you use Git, `git clone <address>`.
3. **A browser:** Chrome, Edge, Firefox or Safari.
4. **Only for Python apps: Python 3.12 or newer.** Type `python3 --version` to check. If you do not have it, install it from [python.org](https://www.python.org/downloads/) (on a Mac, `brew install python` also works). If you use [uv](https://docs.astral.sh/uv/), codeTAC uses it too, and uv downloads any Python that is missing. See [Python apps](/guide/python-apps).

::: tip How to open the Terminal
- **Mac:** press Cmd+Space, type “Terminal”, press Enter.
- **Windows:** Start menu, type “PowerShell”, press Enter. codeTAC has not been tested on Windows yet.
:::

## Which apps work

| Works (tested) | Should work (not tested yet) | Does not work yet |
| --- | --- | --- |
| Next.js, Vite + React, Express, TanStack Start, projects with a separate frontend and backend, monorepos | Nuxt, SvelteKit, Astro, Remix, NestJS, Fastify… | Django, PHP, Go, Ruby (Laravel, Rails…) |
| FastAPI and Flask (Python) | | Sites with only HTML and JavaScript, with no Node or Python server |
| A Node frontend with a Python API in the same folder | | Parts that run on Bun, Deno, Cloudflare Workers or in Next.js middleware |
| | | Apps that only exist in the cloud or in production |

## Step 1 — Install

In the Terminal, type:

```sh
npm install -g codetac
```

Check that it worked:

```sh
codetac --version
```

It shows a version number.

::: warning If you see a permissions error (`EACCES`)
Use `npx codetac` instead of `codetac` in every step below. It works without installing.
:::

## Step 2 — Go to your project's folder

Type `cd ` (with a space after it), **drag your project's folder into the Terminal window**, and press Enter.

## Step 3 — Start your app with codeTAC

```sh
codetac
```

codeTAC tells you what it is going to start, for example:

```
  Start: Vite · npm run dev
```

It may ask you a question first. **Pressing Enter means yes.**

- **Dependencies missing?** It asks whether to install them.
- **A Python app with no environment?** It asks whether to create a `.venv` in the project folder and install what the project lists (`requirements.txt`, `pyproject.toml` or `uv.lock`).
- **A `.env.example` but no `.env`?** It warns you. Many apps need that file: copy `.env.example` to `.env` and fill in the values.
- **Several parts** (for example a frontend and an API)? It asks which ones to start. Enter starts them all.

## Step 4 — Wait for “App ready”

When you see

```
✓ App ready at http://localhost:…
```

the browser opens with your app.

- **A FastAPI API** opens its interactive documentation (`/docs`). Each **Try it out** gets a dossier.
- **A Node API with no pages** does not open the browser. Send requests as you usually do; each one gets a dossier. The link to the panel is shown in the Terminal.

## Step 5 — Use your app

Click a button, follow a link, submit a form.

- A small bar saying **Recorded: …** appears in the bottom right corner of the page.
- The Terminal shows **✓ First dossier …** with a link.

![The codeTAC bar in the bottom right corner of an app, after a click on “Add user”: “Recorded: button “Add user””, next to the Structure pill](/img/bar.png)

## Step 6 — Open the dossier

Click the bar, or open the link from the Terminal. You now see what your click did. [How to read it](/guide/what-happens-when-i-click).

## Step 7 — Stop

Go back to the Terminal and press **Ctrl+C**. Your app stops, and nothing in it has changed.

## What it means

For an app codeTAC already knows how to start, the first dossier usually arrives in **less than a minute**. From then on, every action you make in your app gets its own dossier, and they are all kept on your computer (in a folder called `~/.codetac`).

## What it can't tell you

- If your app does not start **without** codeTAC either (missing keys in `.env`, a database that is not running), codeTAC cannot fix that. It shows the app's own error, with the file and line. See [When something goes wrong](/guide/when-something-goes-wrong).
- codeTAC is for your app **on your computer, while you develop it**. It does not watch apps in production.

## Next

- **Using Claude Code?** In your project's folder, run `codetac hooks install` once. From then on, after each prompt, the bar shows **What changed?**, a report of what that prompt did to your project: [What did my last prompt change?](/guide/what-did-my-last-prompt-change)
- **What is your project made of?** Press **Structure** on the bar: [the floor plan](/guide/the-floor-plan).
