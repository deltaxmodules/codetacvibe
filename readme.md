# codeTAC

**Your app was built by AI. Is it safe to ship — and what does its code really do?**

A free, local tool for Node.js and Python (FastAPI, Flask) web apps, including those made with Lovable, Bolt, v0, Cursor, Replit or Claude Code. No account, no cloud: everything runs on your computer.

![After a Claude Code prompt, the bar's «What changed?» button opens the report: the sentences, each with its lines of code and its box on the map](https://raw.githubusercontent.com/deltaxmodules/codetacvibe/main/site/public/img/demo-what-changed.gif)

**Watch the 3-minute demo:** [from the install to the buttons](https://deltaxmodules.github.io/codetacvibe/#see-it-in-under-3-minutes).

## Three commands

**1. Is my app safe to ship?**

```sh
npx codetac check
```

Reads your project without starting it, and answers in seconds:
- 🔴 **do not ship like this** — for example, a `.env` file in git, a secret key that ends up in the browser, or a database table anyone can read from the browser;
- 🟡 **look at this** — for example, a live payment key or a remote database in your local setup;
- ✅ **checked and fine.**

Every alert says **why** and **where** (file and line). Secret values are never shown. It ends with 1 on a 🔴, so a CI job can stop on it; `--json` is for machines. → [Is my app safe to ship?](https://deltaxmodules.github.io/codetacvibe/guide/is-my-app-safe-to-ship)

**2. What happens when I click?**

```sh
npm install -g codetac
codetac
```

Starts your app. Click a button and codeTAC shows a **dossier** of that action: the server functions that ran, with file and line, and what touched the database, email, payments, AI and other services. **Structure** shows the floor plan of the whole project, with the path of the click lit on it. → [Get started in 5 minutes](https://deltaxmodules.github.io/codetacvibe/guide/get-started)

**3. What did my last prompt change?** (Claude Code)

```sh
codetac hooks install
```

After every prompt, a report: the files, the risks (a new outside service, a new dependency, a secret in the browser), a map and the lines of code, with **Undo**. While the prompt runs, `codetac live` shows what the assistant is building, step by step. → [What did my last prompt change?](https://deltaxmodules.github.io/codetacvibe/guide/what-did-my-last-prompt-change)

## What you need

- **Node.js 20 or newer** for `check`; **Node.js 24 or newer** for the rest (also for Python apps, because codeTAC installs with npm).
- For Python apps, **Python 3.12 or newer** to follow the app's functions (3.8–3.11 work in minimal mode).
- Your app's project on your computer. Apps made with Lovable, Bolt, v0 or Replit: connect them to GitHub and download them.

Tested on macOS and Linux. On Windows, `check` and the floor plan are tested; starting your app with codeTAC does not work there yet.

**Works with:** Next.js, Vite + React, Express, TanStack Start, monorepos, FastAPI, Flask, and a Node frontend with a Python API. **Not yet:** Django, PHP, Go, Ruby, Bun, Deno, Cloudflare Workers. → [Which apps work](https://deltaxmodules.github.io/codetacvibe/guide/get-started#which-apps-work)

## The manual

Everything else — reading a dossier, the floor plan, secrets, what leaves your computer, AI explanations, privacy, commands, limits and what to do when something does not work — is in the manual: **[deltaxmodules.github.io/codetacvibe](https://deltaxmodules.github.io/codetacvibe/)**.

## Privacy

Your code is not changed and nothing leaves your computer. AI explanations are optional (a local model, or your own key), and you see exactly what would be sent before it goes. → [Privacy and AI](https://deltaxmodules.github.io/codetacvibe/guide/privacy-and-ai)

## Development

This repository holds the published code: the same files as the npm package. The tests and the test projects live in the development repository (some hold fake keys on purpose, to test the secret alerts).

```sh
git clone https://github.com/deltaxmodules/codetacvibe.git
cd codetacvibe
npm ci
node src/cli.mjs help
```

[Changelog](CHANGELOG.md) · [MIT license](LICENSE)
