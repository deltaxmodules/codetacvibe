# What did my last prompt change?

**What this page is for:** after each prompt you give **Claude Code**, seeing **what that prompt changed**: files, structure, risks and the lines of code. It works without you remembering to take a snapshot first.

It is the automatic version of [What did the AI change?](/guide/what-did-the-ai-change). There, you save a snapshot by hand before a change. Here, Claude Code's hooks tell codeTAC when each prompt starts and ends, and codeTAC keeps the files of both moments.

## Steps

1. In your project's main folder, once:

   ```
   codetac hooks install
   ```

   It shows what it will write and asks first. It adds three hooks to `.claude/settings.local.json` and writes nothing else in the project.
2. Start your app with codeTAC as usual (`codetac`).
3. Open Claude Code **in the same folder** and give it a prompt.
4. While the prompt runs, the bar in your app shows **Prompt running…**. When it ends, it shows **What changed?** with the number of changes and, in orange, the number to look at.
5. Press **What changed?** to open the report of that prompt.

![The bar while a prompt runs (Prompt running…) and after it (What changed? with 5 changes and 2 to look at)](/img/diff-bar.png)

To stop recording: `codetac hooks uninstall`. It puts `.claude/settings.local.json` back as it was (or removes it, if codeTAC created it). The prompts already recorded stay in codeTAC's data folder.

## What you see

![The report of a prompt: the sentences on the left (a new external service, a new dependency, a new block, the files), the map on the right with the new file in green and package.json in orange, the code below](/img/diff-report.png)

At the top: the text of the prompt, when it ran, whether it ended (**done**) or was stopped (**interrupted**), and how many files were added, changed and removed.

### The sentences

Made by rules (no AI), the most important first, in two groups:

- **Look at these**: what can hurt you, for example:
  - a secret that now reaches the browser;
  - a new outside service (data leaves your computer);
  - a new, removed or changed dependency in `package.json`, `requirements.txt` or `pyproject.toml`;
  - a test file deleted, or a file with fewer tests;
  - a new route **possibly** without a session check (a guess: none of the known checks is near it).
- **Flow and data**: blocks, routes, tables, variables and files added, removed or changed.

Each sentence says **read in the code** (it comes from the files, not from a guess) and has its tags: **leaves the machine**, **secrets**. The `#1`, `#2` link to the blocks of lines that prove it.

### Press a sentence

The sentence lights up its blocks of lines in the code and its boxes on the **Map**.

### Press a box on the map

The sentences about that box light up. The map is the [floor plan](/guide/the-floor-plan) of the project before and after the prompt: added in green, changed in orange, removed with a dashed border.

### The code

Below, every changed file, old lines beside new ones, in blocks. Each block says which sentences it **explains**. A block no sentence explains is counted at the top of the code: these are the changes the rules have nothing to say about, so read them yourself.

### Other prompts and the history

**◀ previous prompt** and **next prompt ▶** move between prompts. **History** lists them all, newest first, with how many changes each has, how many to look at and how many you have not opened yet.

## Without the app running

```
codetac diff            # the newest prompt, in the Terminal
codetac diff 3          # prompt 3
codetac diff --list     # all the prompts recorded
codetac diff --code     # with the lines
codetac diff --open     # the same report, in the panel
```

`codetac diff --open` starts the panel by itself when it is not running. That panel keeps running after the command.

## Where the prompts are kept

In `~/.codetac/diff/` on your computer, never inside your project, and nothing is sent anywhere. For each prompt codeTAC keeps:

- **the text of the prompt**, with secrets hidden: the values of your `.env` files, keys in known formats, emails and phone numbers become `[REDACTED]`;
- **a copy of the project's files** before and after (the same files the plan reads: what git ignores is left out). Only the **names** of the variables in `.env` files are kept, never their values, and keys written in the code are masked. Files over 2 MB are listed without a copy.

The 50 newest prompts are kept for each project. You can change that with `diff.keep` in the [settings file](/reference/settings-file).

## What it means

Claude Code says it "added a payment button". The report shows it also added a new outside service, a new dependency and a secret that now goes into the browser code, with the lines. You can catch it at the prompt that did it, not three prompts later.

## What it can't tell you

- **Only Claude Code** says when a prompt starts and ends. For other AI tools (Cursor, Codex…), use a [snapshot by hand](/guide/what-did-the-ai-change).
- **Two Claude Code sessions** working on the same project at once, or a subagent still working when the next prompt starts, mix their changes: the report warns that some of the changes may be from the other one.
- Edits you make by hand while a prompt runs count as the prompt's.
- The diff is of **whole lines**: changing only spaces counts as a change.
- The rules for risks are rules: a route **possibly** without a session check is a guess, and a dependency or test the rules do not know is not seen.
- With the browser window hidden or covered by another window, the bar waits until you see it again to ask for news.
