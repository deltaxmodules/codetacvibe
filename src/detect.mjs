// Deteção do projeto (Fase 5): gestor de pacotes, stack, script de arranque e
// porta provável, sem lista fechada de stacks. O que não se consegue deduzir
// fica em `missing`, para o comando perguntar ao utilizador.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { describePythonFolder, hasPythonSignals } from './detect-python.mjs';

// Ordem de preferência dos scripts de desenvolvimento.
const SCRIPTS = ['dev', 'start:dev', 'develop', 'serve', 'dev:server', 'server', 'start'];
// Stacks conhecidas só para dar um nome e uma porta por omissão; as outras
// arrancam na mesma, pelo script.
const STACKS = [
  { dep: 'next', name: 'Next.js', port: 3000 },
  { dep: 'nuxt', name: 'Nuxt', port: 3000 },
  { dep: '@remix-run/dev', name: 'Remix', port: 5173 },
  { dep: '@react-router/dev', name: 'React Router', port: 5173 },
  { dep: '@sveltejs/kit', name: 'SvelteKit', port: 5173 },
  { dep: 'astro', name: 'Astro', port: 4321 },
  { dep: '@angular/core', name: 'Angular', port: 4200 },
  { dep: '@nestjs/core', name: 'NestJS', port: 3000 },
  { dep: 'react-scripts', name: 'Create React App', port: 3000 },
  { dep: 'fastify', name: 'Fastify', port: 3000 },
  { dep: 'hono', name: 'Hono', port: 3000 },
  { dep: 'koa', name: 'Koa', port: 3000 },
  { dep: 'express', name: 'Express', port: 3000 },
  { dep: 'vite', name: 'Vite', port: 5173 },
];
const ENTRIES = ['server.js', 'server.mjs', 'server.ts', 'index.js', 'index.mjs', 'index.ts', 'app.js', 'app.ts',
  'src/server.ts', 'src/server.js', 'src/index.ts', 'src/index.js', 'src/main.ts', 'src/app.ts', 'server/index.ts', 'server/index.js'];
const SKIP_FOLDERS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'public', 'docs', 'test', 'tests', 'e2e', 'scripts',
  'venv', 'env', '__pycache__', 'site-packages']);

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}
function readText(path, limit = 200_000) {
  try { return readFileSync(path, 'utf8').slice(0, limit); } catch { return ''; }
}

export function packageManager(root) {
  let folder = root;
  // Workspaces keep the lockfile at the top; look up to three levels.
  for (let level = 0; level < 4; level++) {
    if (existsSync(join(folder, 'pnpm-lock.yaml'))) return 'pnpm';
    if (existsSync(join(folder, 'yarn.lock'))) return 'yarn';
    if (existsSync(join(folder, 'bun.lockb')) || existsSync(join(folder, 'bun.lock'))) return 'bun';
    if (existsSync(join(folder, 'package-lock.json'))) return 'npm';
    const up = join(folder, '..');
    if (up === folder) break;
    folder = up;
  }
  return 'npm';
}

function dependencies(pkg) {
  return { ...pkg?.dependencies, ...pkg?.devDependencies };
}

export function stackOf(pkg, script = '') {
  const deps = dependencies(pkg);
  // The script names the tool actually used (a project may carry several).
  const byScript = STACKS.find(stack => new RegExp(`(^|[\\s/"'])${stack.dep.split('/').pop()}(\\s|$)`).test(script) && deps[stack.dep]);
  return byScript ?? STACKS.find(stack => deps[stack.dep]) ?? null;
}

// Runtimes other than Node cannot load CodeTAC's hooks.
export function foreignRuntime(command) {
  const match = String(command).match(/(?:^|[\s;&|(])(bun|deno|python3?|uvicorn|php|go run|cargo)\b(?!-)/);
  return match ? match[1] : null;
}

export function chooseScript(pkg) {
  const scripts = pkg?.scripts ?? {};
  for (const name of SCRIPTS) {
    const command = scripts[name];
    // A "start" that only serves a production build is still a way to run it,
    // but a "dev" is preferred (it is first in the list).
    if (typeof command === 'string' && command.trim()) return { name, command };
  }
  return null;
}

// Port from the script arguments, the .env files, the source, or the stack default.
export function portOf(root, script, stack) {
  const fromScript = String(script ?? '').match(/(?:--port[= ]|-p[= ]?|PORT=)(\d{2,5})\b/);
  if (fromScript) return { value: Number(fromScript[1]), source: 'script' };
  for (const name of ['.env.development.local', '.env.local', '.env.development', '.env']) {
    const match = readText(join(root, name)).match(/^\s*(?:export\s+)?(?:APP_)?PORT\s*=\s*["']?(\d{2,5})/m);
    if (match) return { value: Number(match[1]), source: name };
  }
  const configs = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'astro.config.mjs', 'nuxt.config.ts'];
  for (const name of configs) {
    const match = readText(join(root, name)).match(/\bport\s*:\s*(\d{2,5})/);
    if (match) return { value: Number(match[1]), source: name };
  }
  for (const name of ENTRIES) {
    const text = readText(join(root, name));
    const match = text.match(/PORT\s*(?:\|\||\?\?)\s*["']?(\d{2,5})/) ?? text.match(/\.listen\(\s*(\d{2,5})\b/)
      ?? text.match(/\bport\s*[:=]\s*(\d{4,5})\b/);
    if (match) return { value: Number(match[1]), source: name };
  }
  if (stack?.port) return { value: stack.port, source: `${stack.name} default` };
  return null;
}

function entryFile(root, pkg) {
  const main = pkg?.main && existsSync(join(root, pkg.main)) ? pkg.main : null;
  return main ?? ENTRIES.find(name => existsSync(join(root, name))) ?? null;
}

// One folder with a package.json: how to start it.
export function describeFolder(folder, top = folder) {
  const pkg = readJson(join(folder, 'package.json'));
  if (!pkg) return null;
  const manager = packageManager(folder);
  const script = chooseScript(pkg);
  const entry = script ? null : entryFile(folder, pkg);
  const stack = stackOf(pkg, script?.command);
  const foreign = script ? foreignRuntime(script.command) : null;
  // A Bun lockfile does not require Bun at run time: the scripts run with Node.
  const runner = manager === 'bun' || foreign === 'bun' ? 'npm' : manager;
  let command = null;
  if (script) command = [runner, 'run', script.name];
  else if (entry) command = ['node', entry];
  return {
    folder, part: relative(top, folder) || '.', name: pkg.name ?? basename(folder), manager, runner,
    stack: stack?.name ?? null, script, entry, command, foreign,
    port: portOf(folder, script?.command, stack),
    installed: existsSync(join(folder, 'node_modules')) || existsSync(join(top, 'node_modules')),
    workspaces: Boolean(pkg.workspaces) || existsSync(join(folder, 'pnpm-workspace.yaml')),
  };
}

function childFolders(root) {
  const found = [];
  const visit = (folder, depth) => {
    let names = [];
    try { names = readdirSync(folder); } catch { return; }
    for (const name of names) {
      if (name.startsWith('.') || SKIP_FOLDERS.has(name)) continue;
      const path = join(folder, name);
      try { if (!statSync(path).isDirectory()) continue; } catch { continue; }
      // A folder with its own package.json, or a Python project (api/, backend/…).
      if (existsSync(join(path, 'package.json')) || hasPythonSignals(path)) found.push(path);
      else if (depth < 1) visit(path, depth + 1);
      if (depth < 1 && ['apps', 'packages'].includes(name)) visit(path, depth + 1);
    }
  };
  visit(root, 0);
  return [...new Set(found)];
}

function devPieces(part) {
  const pkg = readJson(join(part.folder, 'package.json'));
  const scripts = pkg?.scripts ?? {};
  if (scripts.dev) return [];
  return Object.keys(scripts).filter(name => /^dev:(?!.*(db|test|lint|type|build|seed|migrat))/.test(name)).map(name => {
    // "cd server && npm run dev" or "npm --prefix server run dev": the piece
    // lives in a subfolder, with its own dependencies.
    const sub = scripts[name].match(/^\s*cd\s+([\w./-]+)\s*&&|--prefix[= ]([\w./-]+)|(?:^|\s)-C\s+([\w./-]+)/);
    const inner = sub ? describeFolder(join(part.folder, sub[1] ?? sub[2] ?? sub[3]), part.folder) : null;
    const stack = inner?.stack ? { name: inner.stack } : stackOf({ ...pkg, dependencies: {} }, scripts[name]);
    return { ...part, part: `. (${name})`, script: { name, command: scripts[name] }, command: [part.runner, 'run', name],
      stack: stack?.name ?? null, port: inner?.port ?? portOf(part.folder, scripts[name], stack), foreign: foreignRuntime(scripts[name]) ?? inner?.foreign ?? null,
      ...(inner ? { installFolder: inner.folder, installed: inner.installed && existsSync(join(inner.folder, 'node_modules')), manager: inner.manager } : {}) };
  });
}

// A folder without package.json but with a server file (node server.js).
function plainEntry(root) {
  const entry = ENTRIES.find(name => existsSync(join(root, name)));
  if (!entry) return null;
  return { folder: root, part: '.', name: basename(root), manager: 'npm', runner: 'npm', stack: null, script: null, entry,
    command: ['node', entry], foreign: null, port: portOf(root, '', null), installed: true, workspaces: false };
}

// The project: the top folder, and the parts that can be started. A top
// package.json whose script already starts everything is enough on its own;
// otherwise the parts with their own scripts are offered (client + server…).
export function detectProject(root) {
  const node = describeFolder(root);
  // A package.json that starts nothing (only tooling) does not hide a Python app in the same folder.
  const top = (node?.command ? node : null) ?? describePythonFolder(root) ?? node ?? plainEntry(root);
  const parts = childFolders(root).map(folder => describeFolder(folder, root) ?? describePythonFolder(folder, root)).filter(part => part?.command);
  let start = [];
  // Without a "dev" script, several "dev:*" scripts (dev:server + dev:client…)
  // are started together: that is how such projects run in development.
  const pieces = top ? devPieces(top) : [];
  if (pieces.length > 1) start = pieces;
  // A frontend at the top and a Python API in a subfolder (backend/, api/): both run,
  // unless the top script already starts Python itself.
  else if (top?.command && top.language !== 'python' && !/^(python3?|uvicorn)$/.test(top.foreign ?? '') && parts.some(part => part.language === 'python')) {
    start = [top, ...parts.filter(part => part.language === 'python')];
  } else if (top?.command) start = [top];
  else if (parts.length === 1) start = parts;
  // A frontend and a Python API (web/ + api/): both run in development.
  else if (!top?.command && parts.some(part => part.language === 'python') && parts.some(part => part.language !== 'python')) start = parts;
  const missing = [];
  if (!top && !parts.length) missing.push('package');
  else if (!start.length && parts.length > 1) missing.push('part');
  else if (!start.length) missing.push('command');
  return { root, name: top?.name ?? basename(root), top, parts, start, missing };
}

// The sentence the command shows before starting.
export function describeStart(part) {
  const shown = part.language === 'python' && part.python.interpreter
    ? part.command.map(token => token === part.python.interpreter ? relative(part.folder, token) || token : token) : part.command;
  const what = part.language === 'python'
    ? `${shown.join(' ')}${part.python.declared ? `  (from ${part.python.declaredSource})` : ''}${part.python.version ? `  · Python ${part.python.version}` : ''}`
    : part.script ? `${part.command.join(' ')}  (script “${part.script.name}”: ${part.script.command})` : part.command.join(' ');
  return `${part.part === '.' ? '' : `[${part.part}] `}${part.stack ? `${part.stack} · ` : ''}${what}`;
}
