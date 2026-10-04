# Commands

Everything you can type in the Terminal. `codetac help` shows the same list.

## Commands

| Command | What it does |
| --- | --- |
| `codetac [folder]` | starts your app with codeTAC (default: the current folder) |
| `codetac check [folder]` | [is the app safe to ship?](/guide/is-my-app-safe-to-ship) Reads the code (nothing is started) and marks what blocks shipping (🔴), what to look at (🟡) and what is fine (✅), with the file and line. Ends with 1 when there is a 🔴. Works from Node 20 |
| `codetac diagnose [folder]` | explains what works and what does not |
| `codetac report [folder]` | saves the diagnosis to a file, to attach to an issue |
| `codetac structure [folder]` | lists the project's files by block, its tables and a summary of the structure's health |
| `codetac structure --reclassify <file> <block\|auto>` | puts a file in a block yourself (`auto` gives it back to the rules); saved in `codetac.structure.json` |
| `codetac structure --suggest` | asks the AI where the Unknown files belong, showing first what is sent |
| `codetac structure --snapshot [label]` | saves the structure as it is now, to compare with later (kept outside the project) |
| `codetac structure --snapshot [label] --predict` | first asks what you expect the next change to do, and saves it with the snapshot |
| `codetac structure --snapshots` | lists the saved snapshots, newest first |
| `codetac structure --diff [from] [to]` | what changed since the newest snapshot, or between two points: a snapshot id, a commit (`HEAD~3`, a branch, a tag) or now |
| `codetac hooks install` / `uninstall` | the Claude Code hooks that record each prompt and the files before and after it, and the steps for the live window (asks first; written in `.claude/settings.local.json`) |
| `codetac diff [n]` | what prompt `n` changed (the newest by default): files, structure, risks; `--code` adds the lines, `--open` opens the report in the panel |
| `codetac diff --list` | the prompts recorded, newest first |
| `codetac diff undo [n]` | puts the files back as they were before prompt `n` (only the newest prompt, only if the files did not change since); shows the files and asks first (`--yes` to skip) |
| `codetac diff redo [n]` | puts back what an undone prompt changed |
| `codetac live [folder]` | opens [the live window](/guide/what-is-the-ai-doing-right-now): what Claude Code is building, step by step (`--no-open`: only prints the address) |
| `codetac live replay [session] [folder]` | the steps and the sentences of a recorded Claude Code session (the newest by default); `--json` for the raw data |
| `codetac privacy` | what codeTAC may send to an AI, with a switch for each kind |
| `codetac help` | all the options |
| `codetac --version` | the installed version |

### `codetac check` options

| Option | What it does |
| --- | --- |
| `--json` | the report for machines ([JSON Schema](https://deltaxmodules.github.io/codetacvibe/schema/check-report.v1.json)) |
| `--fail-on red\|yellow` | `red` (default): ends with 1 on a 🔴; `yellow`: also on a 🟡 |

### `codetac privacy` options

| Option | What it does |
| --- | --- |
| `--no-ai` / `--ai` | turns all AI requests off / back on |
| `--on <kind>`, `--off <kind>`, `--default <kind>` | one kind: `purposes`, `questions`, `suggestions`, `explanations`, `requests` |
| `--log [n]` | shows the last requests sent |
| `--clear-log` | clears the log |

### What `--diff` prints

Sentences made by rules, the most important first: `!!` alert, `!` warning, `·` information, each with the file and line. `[leaks]` and `[secrets]` mark what touches data leaving your computer or secrets.

## Options for starting your app

| Option | What for |
| --- | --- |
| `--script <name>` | use another script from `package.json` (default: `dev`, `start`…) |
| `--part <folder>` | in a project with several parts, which one to start (can repeat) |
| `--port <n>` | the app's port, if it is not found automatically |
| `--panel-port <n>` | the panel's port (default 4000) |
| `--minimal` | do not follow the project's functions (requests and outside services only) |
| `--yes` | answer “yes” to the questions (install dependencies, create the `.venv`…) |
| `--no-open` | do not open the browser |
| `-- <command>` | the start command, when it is not found, for example `codetac -- node server.js` or `codetac -- uvicorn main:app --reload` |

## Variables

| Variable | What for |
| --- | --- |
| `CODETAC_HOME` | where codeTAC keeps its records (default `~/.codetac`) |
| `CODETAC_PYTHON` | which Python reads your `.py` files for Structure |
| `CODETAC_AI_PROVIDER`, `CODETAC_AI_MODEL`, `CODETAC_AI_KEY`, `CODETAC_AI_URL` | the AI model, instead of `~/.codetac/ai.json` |
| `CODETAC_AI_CONFIG` | another file instead of `~/.codetac/ai.json` |
