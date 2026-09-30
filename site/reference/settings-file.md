# Settings file

You do not need this file: codeTAC works without it. Create it only when you want to change how **Structure** reads your project.

The file is called `codetac.structure.json` and goes in your project's **main folder**. codeTAC never creates it on its own — except when you move a file with `codetac structure --reclassify`. A mistake in the file is shown on the plan and never stops it.

## Example

```json
{
  "version": 1,
  "ignore": ["generated/", "*.stories.tsx"],
  "layers": { "src/jobs/": "logic", "packages/db/": "data" },
  "reclassify": { "misc/seed.js": "data" },
  "services": [
    { "id": "openai", "jurisdiction": "USA" },
    {
      "id": "acme",
      "name": "Acme CRM",
      "category": "http",
      "hosts": ["api.acme.example"],
      "jurisdiction": "EU (Frankfurt)"
    }
  ],
  "env": { "platform": ["PORT", "DATABASE_URL"] },
  "smells": { "largeFileLines": 600, "off": ["unused-export"] },
  "snapshots": { "keep": 20 }
}
```

## Each setting

| Setting | What it does |
| --- | --- |
| `ignore` | files left out of the plan, on top of `.gitignore` (same patterns: `*`, `**`, a `/` at the end for a folder) |
| `layers` | your own rules, pattern → block, applied before codeTAC's (the first that matches wins) |
| `reclassify` | one file → block; always wins |
| `services` | the **jurisdiction** of a service (where it keeps the data), or a service of your own |
| `env.platform` | variables set outside the `.env` files (hosting platform, CI), so they are not listed as “used but never defined” |
| `smells` | the limits of the structure health checks, and kinds turned off |
| `snapshots.keep` | how many snapshots are kept for this project (default 20; the oldest go first) |

**Blocks:** `interface`, `routes`, `logic`, `data`, `external`, `config`, `utilities`, `tests`, `unknown`.

## A service of your own

Give it an `id`, a `name`, a `category` and how to recognise it:

- **categories:** `ai`, `database`, `payments`, `analytics`, `monitoring`, `email`, `messaging`, `storage`, `auth`, `http`;
- **by address:** `"hosts": ["api.acme.example"]`;
- **by npm SDK:** `"sdk": [{ "package": "@acme/sdk", "create": ["Acme"] }]`;
- **by Python SDK:** `"python": [{ "module": "acme_sdk", "create": ["Client"] }]`;
- `"*"` means any call through the module.

About 50 services are known out of the box.

## Structure health limits

| Key | Default |
| --- | --- |
| `largeFileLines` | 400 |
| `duplicateTokens` | 80 |
| `duplicateLines` | 8 |
| `couplingFiles` | 25 |
| `couplingBlocks` | 4 |

Turn a kind off with `"off": ["unused-export"]`.

## AI settings

The AI model is set in a different file, `~/.codetac/ai.json`, in your home folder — not in the project. See [Privacy and AI](/guide/privacy-and-ai).
