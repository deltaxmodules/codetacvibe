# When something goes wrong

**What this page is for:** understanding codeTAC's messages and getting your app running again.

## First: ask codeTAC

With the app running, open **another** Terminal window, go to the same folder, and type:

```sh
codetac diagnose
```

Each line starts with:

- **✓** it works;
- **!** a warning;
- **✗** a problem — with what to do.

## Common messages

### “I did not find a package.json…”

You are in the wrong folder. Go to the folder that has the `package.json` file (for a Python app: the `requirements.txt`, the `pyproject.toml`, or the `main.py`/`app.py`). Or give the start command yourself:

```sh
codetac -- node server.js
codetac -- uvicorn main:app
```

### “I found a Python project, but not the app…”

codeTAC did not find `FastAPI(...)` or `Flask(...)`. Give the start command: `codetac -- uvicorn main:app` or `codetac -- flask --app app run`.

### “This project uses Django…”

Django is not supported yet (only FastAPI and Flask).

### “Port 3000 is already taken…”

Another program is using that port — often another app open in another Terminal window. Close it. For an app with a single part, codeTAC moves to another port by itself.

### “The app itself failed while starting: …”

The error comes from **your app's own code**, at the file and line shown, and would happen without codeTAC too. Often it is configuration: a folder, key or service in `.env` that does not exist on this computer (for example a production path such as `/var/lib/…`).

### “The app failed in minimal mode too”

The problem is in the app itself. Often the keys in the `.env` file are missing (Supabase, Firebase…). Check the `.env.example` or the project's instructions.

### “The home page answered with error 500”

The app started, but the page fails. The dossier of that page load shows where — open it.

### “Port 5000 is already taken by the macOS AirPlay Receiver…”

On a Mac, port 5000 (Flask's usual port) belongs to AirPlay. codeTAC starts the app on another port. To use 5000, turn off **AirPlay Receiver** in System Settings › General › AirDrop & Handoff.

### “The project's Python is …”

The app runs on a Python older than 3.12, so functions are not followed. Delete the `.venv` folder, make sure a newer Python is installed, and run `codetac` again: it creates a new `.venv`.

### “hypercorn is not recognised yet” (or granian)

Start the app with uvicorn instead: `codetac -- uvicorn main:app`.

### The bar does not show up on the page

Reload the page. Check that the address in the browser is the one codeTAC showed in the Terminal.

### `EACCES` when installing

Use `npx codetac` instead of `codetac`.

## Reporting a problem

```sh
codetac report
```

It saves the diagnosis to a file, **with no code or data from your app**. Open an issue at [github.com/deltaxmodules/codetacvibe/issues](https://github.com/deltaxmodules/codetacvibe/issues), attach the file, and say what you did and what you expected.
