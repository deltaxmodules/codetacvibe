---
layout: home

hero:
  image:
    light: /logo.png
    dark: /logo-dark.png
    alt: codeTAC
  text: See what your app's code does, one action at a time.
  tagline: For people who build web apps with AI (Lovable, Bolt, v0, Cursor, Replit, Claude Code…) and want to know what the code really does. Free, and everything runs on your computer.
  actions:
    - theme: brand
      text: Is my app safe to ship?
      link: /guide/is-my-app-safe-to-ship
    - theme: alt
      text: Get started in 5 minutes
      link: /guide/get-started
    - theme: alt
      text: What happens when I click?
      link: /guide/what-happens-when-i-click

features:
  - title: Is my app safe to ship?
    details: One command, under a minute, nothing to set up. A table anyone can read, a secret key in the browser, a .env file in git, a live key in your local setup — each with the file and line. Values are never shown.
    link: /guide/is-my-app-safe-to-ship
  - title: Click, and see what ran
    details: Press a button in your app. codeTAC shows a dossier of that action — the server functions that ran, the database, emails, payments and AI calls — each with its file and line.
    link: /guide/what-happens-when-i-click
  - title: See the whole project
    details: A floor plan of what your project is made of, read from the code. The path of your last click is lit on it.
    link: /guide/the-floor-plan
  - title: What leaves your computer
    details: Every outside service your code sends data to, where it is called, and whether the browser calls it directly.
    link: /guide/what-leaves-my-computer
  - title: Are your secrets safe?
    details: Keys that reach the browser, .env files in git, keys written in the code — by name only, never the value.
    link: /guide/are-my-secrets-safe
  - title: What did my last prompt change?
    details: With Claude Code, a report after every prompt — the files, the risks (a new service, a dependency, a secret in the browser), a map and the lines of code. With any other AI tool, save a snapshot before and compare after.
    link: /guide/what-did-my-last-prompt-change
  - title: What is the AI doing right now?
    details: While Claude Code works, a small window beside the terminal says what it is building, step by step and in plain words. At the end, straight to what the prompt changed.
    link: /guide/what-is-the-ai-doing-right-now
  - title: Nothing leaves without you
    details: No account, no cloud. AI explanations are optional, and you see exactly what would be sent before it goes.
    link: /guide/privacy-and-ai
---

![A click on “Add user” in an app, then Structure: the floor plan of the project opens with the path of that click lit](/img/path-of-a-click.gif)

## See it in under 3 minutes

<video controls muted playsinline preload="none" poster="/video/codetac-demo.jpg" src="/video/codetac-demo.mp4" style="width:100%;border-radius:8px" aria-label="codeTAC from the install to the buttons: a dossier of a click, the floor plan, a prompt and its report, run an action again, undo the prompt"></video>

From the install to the buttons: a click and its dossier, the floor plan, a Claude Code prompt and its report, **Run it again** and **Undo**. No sound; captions explain each step.

## Who is it for?

You made an app with an AI tool, or someone made it for you. It works — mostly. But when you press **Save**, you are not sure what happens:

- Which functions run?
- Which table changes?
- Does an email go out?
- Is the payment in test mode or live mode?
- Does my secret key end up in the browser?
- Is my app safe to put on the internet?

codeTAC answers these questions by **watching your app while you use it** and by **reading your project's code**. You do not need to know how to program to read the answers: every step comes with a plain sentence, and every fact comes with the file and line that prove it.

## Which apps?

Web apps in **Node.js** (JavaScript or TypeScript — Next.js, Vite + React, Express…) or **Python** (FastAPI or Flask), running on your computer. [More detail](/guide/get-started#which-apps-work).

## Your code is not changed

codeTAC starts your app for you and watches it from the inside while it runs. It does not edit your files, and it does not need an account. When you stop it (Ctrl+C), your app is exactly as it was.
