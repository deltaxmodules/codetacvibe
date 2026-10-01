// Deteção de projetos Python (Etapa 12 Python, especificação 3.10): sinais,
// interpretador, arranque e porta. Usado pelo detect.mjs; o caminho Node não
// muda. Uma parte Python tem os mesmos campos que uma parte Node, mais
// `language: 'python'` e `python` (interpretador, versão, módulos).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MINIMUM = [3, 12];
const PROBE = fileURLToPath(new URL('./python/probe.py', import.meta.url));
const SIGNALS = ['pyproject.toml', 'uv.lock', 'poetry.lock', 'Pipfile', 'Procfile', 'setup.py'];
const ENVIRONMENTS = ['.venv', 'venv', 'env', '.env'];
const SKIP = new Set(['node_modules', '__pycache__', 'site-packages', 'tests', 'test', 'migrations', 'alembic', 'docs', 'dist', 'build',
  'scripts', 'static', 'templates', 'venv', 'env']);
const PREFERRED = ['main.py', 'app.py', 'server.py', 'api.py', 'application.py', 'wsgi.py', 'asgi.py', '__init__.py'];
const DEFAULT_PORT = { FastAPI: 8000, Flask: 5000 };
// Tools a declared command may start with; they run as `python -m <tool>` with the project's interpreter.
const MODULE_TOOLS = new Set(['uvicorn', 'flask', 'fastapi', 'gunicorn', 'hypercorn']);
const RUNNERS = /^(?:uv run|poetry run|pipenv run|pdm run|rye run)\s+/;
const SERVER_OF = { uvicorn: 'uvicorn', fastapi: 'uvicorn', flask: 'werkzeug', gunicorn: 'gunicorn', hypercorn: 'hypercorn', granian: 'granian', waitress: 'waitress' };

function readText(path, limit = 200_000) {
  try { return readFileSync(path, 'utf8').slice(0, limit); } catch { return ''; }
}
const isDirectory = path => { try { return statSync(path).isDirectory(); } catch { return false; } };
const binary = (environment, name) => process.platform === 'win32' ? join(environment, 'Scripts', `${name}.exe`) : join(environment, 'bin', name);

export function versionBelow(version, minimum = MINIMUM) {
  const [major, minor] = String(version).split('.').map(Number);
  return major < minimum[0] || (major === minimum[0] && minor < minimum[1]);
}

// A folder is a Python project with its own files (not only a virtual environment).
export function hasPythonSignals(folder) {
  if (SIGNALS.some(name => existsSync(join(folder, name)))) return true;
  try {
    const names = readdirSync(folder);
    if (names.some(name => /^requirements.*\.txt$/.test(name))) return true;
    return ENVIRONMENTS.some(name => existsSync(join(folder, name, 'pyvenv.cfg'))) && names.some(name => name.endsWith('.py'));
  } catch { return false; }
}

// The project's own environment: a virtual environment in the folder, or the
// one poetry or pipenv keeps elsewhere (only when the tool is installed).
export function findEnvironment(folder) {
  for (const name of ENVIRONMENTS) {
    const environment = join(folder, name);
    if (existsSync(join(environment, 'pyvenv.cfg')) && existsSync(binary(environment, 'python'))) {
      return { path: environment, interpreter: binary(environment, 'python'), source: name };
    }
  }
  const external = [['poetry.lock', 'poetry', ['env', 'info', '--path']], ['Pipfile', 'pipenv', ['--venv']]];
  for (const [file, tool, args] of external) {
    if (!existsSync(join(folder, file))) continue;
    const result = spawnSync(tool, args, { cwd: folder, encoding: 'utf8', timeout: 15_000 });
    const path = result.status === 0 ? result.stdout.trim().split('\n').pop() : '';
    if (path && existsSync(binary(path, 'python'))) return { path, interpreter: binary(path, 'python'), source: tool };
  }
  return null;
}

// What the interpreter has: version, modules, missing dependencies (src/python/probe.py).
export function probe(interpreter, folder) {
  const result = spawnSync(interpreter, [PROBE, folder], { cwd: folder, encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, PYTHONPATH: '', PYTHONDONTWRITEBYTECODE: '1' } });
  try { return JSON.parse(result.stdout.trim().split('\n').pop()); } catch { return null; }
}

// The application object: FastAPI(...) or Flask(...) assigned at module level.
export function findApp(folder) {
  const found = [];
  const visit = (directory, depth) => {
    let names = [];
    try { names = readdirSync(directory).sort((a, b) => (PREFERRED.indexOf(a) + 1 || 99) - (PREFERRED.indexOf(b) + 1 || 99)); } catch { return; }
    for (const name of names) {
      if (name.startsWith('.') || SKIP.has(name)) continue;
      const path = join(directory, name);
      if (name.endsWith('.py')) {
        const text = readText(path);
        const assigned = text.match(/^(\w+)\s*(?::[^=\n]+)?=\s*(FastAPI|Flask)\(/m);
        const factory = !assigned && /\bFlask\(/.test(text) && text.match(/^def (create_app|make_app)\(/m);
        if (assigned || factory) {
          const file = relative(folder, path);
          const module = file.replace(/\.py$/, '').replace(/[\\/]__init__$/, '').split(sep).join('.');
          found.push({ file, module, variable: assigned ? assigned[1] : `${factory[1]}()`, framework: assigned ? assigned[2] : 'Flask', depth,
            main: /^if __name__ == ['"]__main__['"]/m.test(text), text });
        }
      } else if (depth < 2 && isDirectory(path) && !existsSync(join(path, 'pyvenv.cfg'))) visit(path, depth + 1);
    }
  };
  visit(folder, 0);
  found.sort((a, b) => a.depth - b.depth);
  return found[0] ?? null;
}

// Commands the project declares: Procfile, task runners in pyproject.toml,
// Makefile and README. Only those that start a Python server in development.
const SERVER_COMMAND = /^(?:(?:uv run|poetry run|pipenv run|pdm run|rye run)\s+)?(?:uvicorn\s+\S+:\S+|fastapi\s+(?:dev|run)\b|flask\b.*\brun\b|gunicorn\s|hypercorn\s|granian\s|python3?\s+(?:-\S+\s+)*[\w./-]+\.py\b|python3?\s+-m\s+(?:uvicorn|flask|fastapi|gunicorn|hypercorn))/;
const SERVES = /\b(?:app|application|server|api)\.run\(|\buvicorn\.run\(|\bserve\(|\bmake_server\(|\bsocketio\.run\(|\brun_simple\(/;
export function declaredCommands(folder) {
  const found = [];
  const add = (command, source) => {
    const clean = command.trim().replace(/^\$\s+/, '').replace(/\s+#.*$/, '');
    if (SERVER_COMMAND.test(clean) && !found.some(item => item.command === clean)) found.push({ command: clean, source });
  };
  const procfile = readText(join(folder, 'Procfile')).match(/^web:\s*(.+)$/m);
  if (procfile) add(procfile[1], 'Procfile');
  const pyproject = readText(join(folder, 'pyproject.toml'));
  for (const section of pyproject.split(/^\[/m).filter(part => /^tool\.(taskipy\.tasks|poe\.tasks|pdm\.scripts)\]/.test(part))) {
    for (const match of section.matchAll(/^(dev|start|run|serve|server)\s*=\s*(?:\{[^}]*?cmd\s*=\s*)?["'](.+?)["']/gm)) add(match[2], `pyproject.toml (${match[1]})`);
  }
  const makefile = readText(join(folder, 'Makefile'));
  for (const match of makefile.matchAll(/^(dev|run|start|serve|server):[^\n]*\n((?:\t[^\n]*\n?)+)/gm)) {
    for (const line of match[2].split('\n')) add(line.replace(/^\t@?/, ''), `Makefile (${match[1]})`);
  }
  // README: only commands for development (reload, dev, debug, flask run, python file.py).
  const readme = ['README.md', 'readme.md', 'README.rst', 'README'].map(name => readText(join(folder, name))).find(Boolean) ?? '';
  for (const line of readme.split('\n')) {
    const clean = line.trim().replace(/^\$\s+/, '').replace(/^`|`$/g, '');
    if (/--reload|\bdev\b|--debug|flask\b.*\brun\b|^python3?\s+[\w./-]+\.py/.test(clean)) add(clean, 'README');
  }
  // A command that points at a file or module missing here belongs to another folder;
  // `python file.py` counts only when that file starts a server (not a data script).
  return found.filter(({ command }) => {
    const script = command.match(/python3?\s+(?:-\S+\s+)*([\w./-]+\.py)\b/)?.[1];
    if (script) return existsSync(join(folder, script)) && SERVES.test(readText(join(folder, script)));
    const file = command.match(/fastapi\s+(?:dev|run)\s+([\w./-]+\.py)/)?.[1];
    if (file) return existsSync(join(folder, file));
    const target = command.match(/(?:uvicorn|gunicorn|hypercorn|granian)\s+(?:.*?\s)?([\w.]+):\w+/)?.[1];
    if (target) return existsSync(join(folder, ...target.split('.')) + '.py') || existsSync(join(folder, ...target.split('.'), '__init__.py'));
    return true;
  });
}

function portFromCommand(command) {
  const match = command.match(/(?:--port[= ]|-p[= ]?)(\d{2,5})\b/) ?? command.match(/(?:--bind|-b)[= ]\S*:(\d{2,5})\b/)
    ?? command.match(/\$\{PORT:-(\d{2,5})\}/);
  return match ? Number(match[1]) : null;
}

export function pythonPort(folder, { command = '', app = null, framework = null } = {}) {
  const fromCommand = portFromCommand(command);
  if (fromCommand) return { value: fromCommand, source: 'command' };
  for (const name of ['.env.local', '.env.development', '.env', '.flaskenv']) {
    if (isDirectory(join(folder, name))) continue;
    const match = readText(join(folder, name)).match(/^\s*(?:export\s+)?(?:FLASK_RUN_|APP_|UVICORN_)?PORT\s*=\s*["']?(\d{2,5})/m);
    if (match) return { value: Number(match[1]), source: name };
  }
  // python app.py: the port the file itself passes (app.run(port=…), uvicorn.run(…, port=…)).
  if (app && /python/.test(command)) {
    const match = app.text.match(/\bport\s*=\s*(?:int\(\s*os\.(?:environ\.get|getenv)\(\s*["']PORT["']\s*,\s*["']?)?(\d{2,5})/);
    if (match) return { value: Number(match[1]), source: app.file };
  }
  const name = framework ?? app?.framework;
  if (/fastapi dev|uvicorn/.test(command) || name === 'FastAPI') return { value: 8000, source: 'uvicorn default' };
  if (/flask/.test(command) || name === 'Flask') return { value: 5000, source: 'Flask default' };
  return null;
}

// The command as argv, with the project's interpreter and the port.
export function commandFor(part, port) {
  const interpreter = part.python.interpreter ?? 'python3';
  if (part.python.declared) {
    let text = part.python.declared.replace(RUNNERS, '');
    text = text.replace(/\$\{PORT(?::-\d+)?\}|\$PORT\b/g, String(port));
    if (portFromCommand(text) && !/\$\{PORT/.test(part.python.declared)) {
      text = text.replace(/(--port[= ]|-p[= ]?)\d{2,5}\b/, `$1${port}`).replace(/((?:--bind|-b)[= ]\S*:)\d{2,5}\b/, `$1${port}`);
    }
    const [first, ...rest] = text.split(/\s+/).filter(Boolean);
    // A known server without a port option gets one: the port must be ours to choose.
    const tool = first === 'python' || first === 'python3' ? (rest[0] === '-m' ? rest[1] : null) : first;
    if (!portFromCommand(text) && !/\$\{?PORT/.test(part.python.declared)) {
      if (tool === 'uvicorn' || tool === 'hypercorn' || (tool === 'fastapi' && /\b(dev|run)\b/.test(text)) || (tool === 'flask' && /\brun\b/.test(text))) rest.push('--port', String(port));
      else if (tool === 'gunicorn') rest.push('--bind', `127.0.0.1:${port}`);
    }
    if (/^python3?$/.test(first)) return [interpreter, ...rest];
    if (MODULE_TOOLS.has(first)) return [interpreter, '-m', first, ...rest];
    return [first, ...rest];
  }
  const { app } = part.python;
  switch (part.python.how) {
    case 'fastapi dev': return [interpreter, '-m', 'fastapi', 'dev', app.file, '--port', String(port)];
    case 'uvicorn': return [interpreter, '-m', 'uvicorn', `${app.module}:${app.variable}`, '--reload', '--port', String(port)];
    case 'flask': return [interpreter, '-m', 'flask', '--app', app.variable.endsWith('()') ? `${app.module}:${app.variable}` : app.module, 'run', '--debug', '--port', String(port)];
    case 'python': return [interpreter, app.file];
    default: return null;
  }
}

// Things to say before starting (limits of the capture for this command).
function notesFor(command, python) {
  const notes = [];
  const text = command.join(' ');
  if (python.version && versionBelow(python.version)) {
    notes.push(`The project's Python is ${python.version}: the app runs in minimal mode (requests, boundaries and browser, without following the functions). To see them, use Python ${MINIMUM.join('.')} or newer in the project's environment.`);
  }
  const flags = text.match(/python3?(?:\.\d+)?\s+((?:-[a-zA-Z]+\s+)+)/)?.[1] ?? '';
  const ignored = flags.split(/\s+/).filter(flag => /^-[a-zA-Z]*[EIS]/.test(flag));
  if (ignored.length) notes.push(`The command uses ${ignored.join(' ')}: with that option Python ignores PYTHONPATH or site, and the app runs unobserved. Remove it to use CodeTAC.`);
  if (/\bgranian\b/.test(text)) notes.push('granian calls the app from Rust and CodeTAC does not recognise it yet: the app runs, but requests get no dossier. With uvicorn, everything is visible.');
  if (/\bhypercorn\b/.test(text)) notes.push('hypercorn is not recognised yet: the app runs, but requests get no dossier. With uvicorn, everything is visible.');
  return notes;
}

// One folder with a Python project: how to start it.
export function describePythonFolder(folder, top = folder) {
  if (!hasPythonSignals(folder)) return null;
  const environment = findEnvironment(folder);
  const probed = environment ? probe(environment.interpreter, folder) : null;
  const modules = new Set(probed?.modules ?? []);
  const app = findApp(folder);
  const declared = declaredCommands(folder)[0] ?? null;
  const django = existsSync(join(folder, 'manage.py'));
  let how = null;
  if (declared) how = 'declared';
  else if (app?.framework === 'FastAPI') {
    // Without an environment, the command is the one it will have once created.
    if (!probed || (modules.has('fastapi_cli') && modules.has('fastapi.__main__'))) how = 'fastapi dev';
    else if (modules.has('uvicorn')) how = 'uvicorn';
    else if (app.main) how = 'python';
    else how = 'uvicorn';
  } else if (app?.framework === 'Flask') how = modules.has('flask') || !probed ? 'flask' : app.main ? 'python' : 'flask';
  const python = { interpreter: environment?.interpreter ?? null, environment: environment?.path ?? null, source: environment?.source ?? null,
    version: probed?.version ?? null, modules: [...modules], missing: probed?.missing ?? [], app, how, declared: declared?.command ?? null,
    declaredSource: declared?.source ?? null, django };
  const framework = app?.framework ?? (/fastapi|uvicorn/.test(declared?.command ?? '') ? 'FastAPI' : /flask/.test(declared?.command ?? '') ? 'Flask' : null);
  const port = how ? pythonPort(folder, { command: declared?.command ?? (how === 'python' ? 'python' : how), app, framework }) : null;
  const part = {
    folder, part: relative(top, folder) || '.', name: basename(folder), language: 'python', manager: existsSync(join(folder, 'uv.lock')) ? 'uv'
      : existsSync(join(folder, 'poetry.lock')) ? 'poetry' : existsSync(join(folder, 'Pipfile')) ? 'pipenv' : 'pip',
    stack: framework, script: declared ? { name: declared.source, command: declared.command } : null, entry: null,
    command: null, foreign: null, port, installed: Boolean(probed) && !python.missing.length, workspaces: false, python,
  };
  if (how) part.command = commandFor(part, port?.value ?? DEFAULT_PORT[framework] ?? 8000);
  // python app.py: the server is the one the file starts, known only when it runs.
  part.server = SERVER_OF[part.command?.find(token => SERVER_OF[token]) ?? ''] ?? null;
  part.notes = part.command ? notesFor(part.command, python) : [];
  // The configuration the app may need (cp .env.example .env): the user's to make.
  if (part.command && !existsSync(join(folder, '.env')) && ['.env.example', '.env.sample', '.env.template'].some(name => existsSync(join(folder, name)))) {
    part.notes.push('The project has a .env.example but no .env. If the app needs that configuration, copy it (cp .env.example .env) and fill it in.');
  }
  return part;
}

// The same part on another port (a taken port, or one the others must follow).
// --port with one Python part whose command CodeTAC writes: the app starts on that port.
export function withAskedPort(parts, { port, command } = {}) {
  if (!port || command?.length || parts.length !== 1 || parts[0].language !== 'python' || parts[0].port?.value === port || !commandFor(parts[0], port)) return parts;
  return [{ ...moveTo(parts[0], port), port: { value: port, source: '--port' } }];
}

export function moveTo(part, port) {
  const command = commandFor(part, port);
  const moved = { ...part, port: { value: port, source: 'chosen by CodeTAC' }, command: command ?? part.command };
  // python app.py, or a declared command without a port option: the PORT variable.
  if (!command || !command.join(' ').includes(String(port))) moved.env = { ...part.env, PORT: String(port) };
  return moved;
}

// The environment of a Python part: its virtual environment first in PATH.
export function environmentOf(part) {
  const env = { ...part.env };
  if (part.python?.environment && part.python.source !== 'poetry' && part.python.source !== 'pipenv') env.VIRTUAL_ENV = part.python.environment;
  if (part.python?.environment) env.PATH = [join(part.python.environment, process.platform === 'win32' ? 'Scripts' : 'bin'), process.env.PATH].join(process.platform === 'win32' ? ';' : ':');
  return env;
}

// Interpreters on this computer, newest first (for a new environment).
export function interpreters() {
  const names = ['python3.14', 'python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3', 'python'];
  const found = [];
  for (const name of names) {
    const result = spawnSync(name, ['-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3]); print(sys.executable)'], { encoding: 'utf8', timeout: 10_000 });
    if (result.status !== 0) continue;
    const [version, executable] = result.stdout.trim().split('\n');
    if (!found.some(item => item.executable === executable)) found.push({ name, version, executable });
  }
  const key = version => version.split('.').map(Number).reduce((total, part) => total * 1000 + part, 0);
  return found.sort((a, b) => key(b.version) - key(a.version));
}

// The variables of a frontend's .env files whose value is a local address on a port
// (VITE_API_URL=http://localhost:8000): [{ variable, value, file }]. The values stay
// in memory, to be passed with another port; they are never shown.
const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local'];
export function envAddressesOn(folder, port) {
  const found = new Map();
  for (const file of ENV_FILES) {
    for (const line of (readText(join(folder, file)) ?? '').split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*["']?([^"'\s#]*)/);
      if (match && new RegExp(`^https?://(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\]):${port}(?:/|$)`).test(match[2])) found.set(match[1], { variable: match[1], value: match[2], file });
    }
  }
  return [...found.values()];
}

// The Vite proxy of a frontend: which ports it sends to, and the variable that sets each one.
export function proxyOf(folder, script = '') {
  // The configuration named in the script (vite --config ./config/vite.config.ts), else the usual names.
  const named = String(script).match(/--config[= ](\S+)/)?.[1];
  const text = [...(named ? [named] : []), 'vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts'].map(name => readText(join(folder, name))).find(Boolean) ?? '';
  if (!/\bproxy\b/.test(text)) return null;
  const variables = [...text.matchAll(/process\.env\.(\w+)\s*(?:\?\?|\|\|)\s*['"]?(\d{2,5})/g)].map(match => ({ variable: match[1], port: Number(match[2]) }));
  const literal = [...text.matchAll(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})\b/g)].map(match => Number(match[1]));
  return { variables, literal };
}
