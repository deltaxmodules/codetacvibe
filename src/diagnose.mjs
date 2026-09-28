// `codetac diagnose` (Fase 5): o que está e o que não está a funcionar,
// em linguagem simples, a partir do projeto, do painel e da última gravação.
import { registerHooks } from 'node:module';
import http from 'node:http';
import { join, relative } from 'node:path';
import { dataDirectory } from './home.mjs';
import { detectProject, describeStart } from './detect.mjs';
import { MINIMUM, versionBelow } from './detect-python.mjs';
import { recordingsOf, summarize } from './recording.mjs';
import { describeConfig, loadConfig } from './ai.mjs';

const directory = dataDirectory();

const REASONS = {
  'module-transform-failed': 'files that could not be prepared',
  'source-map-unreadable': 'files with an unreadable source map',
  'eval-code-transform-failed': 'bundler code blocks that could not be prepared',
  'constructor-skipped': 'class constructors (they run, but are not shown)',
  'generator-skipped': 'generators (they run, but are not shown)',
  'parameter-redeclaration-skipped': 'functions that redeclare a parameter (they run, but are not shown)',
  'direct-eval-skipped': 'functions with a direct eval (they run, but are not shown)',
  'template-lines-unmapped': 'templates not linked to the lines of the file (shown as a single step)',
};

function ping(port) {
  return new Promise(done => {
    const request = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 1500, headers: { host: `127.0.0.1:${port}` } }, response => {
      response.resume();
      done(response.statusCode === 200);
    });
    request.on('timeout', () => { request.destroy(); done(false); });
    request.on('error', () => done(false));
  });
}

function panelConfig(port) {
  return new Promise(done => {
    http.get({ host: '127.0.0.1', port, path: '/api/config', timeout: 1500, headers: { host: `127.0.0.1:${port}` } }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => { try { done(JSON.parse(body)); } catch { done(null); } });
    }).on('error', () => done(null));
  });
}

// A Python part: interpreter, version, dependencies, server and start (Etapa 12 Python).
function pythonPart(part, { ok, bad, note }) {
  const label = part.part === '.' ? '' : `[${part.part}] `;
  const { python } = part;
  if (!python.interpreter) bad(`${label}No Python environment (.venv).`, 'codetac creates it and installs the dependencies (it asks first; --yes answers yes).');
  else if (!python.version) bad(`${label}The environment's Python (${relative(part.folder, python.interpreter)}) did not answer.`, 'The environment may be broken: delete the .venv and run codetac again.');
  else if (versionBelow(python.version)) note(`${label}Python ${python.version} (${relative(part.folder, python.interpreter)}): minimal mode only (requests, boundaries and browser, without the functions).`,
    `Create the environment with Python ${MINIMUM.join('.')} or newer.`);
  else ok(`${label}Python ${python.version} (${relative(part.folder, python.interpreter) || python.interpreter}): can follow the project's functions.`);
  if (python.interpreter && python.missing.length) bad(`${label}Missing dependencies: ${python.missing.slice(0, 8).join(', ')}${python.missing.length > 8 ? '…' : ''}.`, 'codetac installs them (it asks first).');
  ok(`Start: ${describeStart(part)}`);
  if (part.server) ok(`${label}Server: ${part.server}.`);
  if (part.port) ok(`${label}Likely port: ${part.port.value} (${part.port.source}). If it is taken, the command picks another.`);
  // The version note is already the first line.
  for (const text of (part.notes ?? []).filter(text => !text.startsWith("The project's Python"))) note(`${label}${text}`);
}

export async function diagnose(root, { panelPort = 4000, out = text => process.stdout.write(`${text}\n`) } = {}) {
  let problems = 0;
  const ok = text => out(`  ✓ ${text}`);
  const bad = (text, fix) => { problems++; out(`  ✗ ${text}`); if (fix) out(`      → ${fix}`); };
  const note = (text, fix) => { out(`  ! ${text}`); if (fix) out(`      → ${fix}`); };

  out(`CodeTAC diagnosis · ${root}\n`);
  out('This computer');
  const [major] = process.versions.node.split('.').map(Number);
  if (major >= 24 && typeof registerHooks === 'function') ok(`Node ${process.version}: can follow the project's functions.`);
  else if (typeof registerHooks === 'function') note(`Node ${process.version}: works, but CodeTAC was checked on Node 24 or newer.`, 'Install Node 24 or newer.');
  else bad(`Node ${process.version}: cannot follow the functions; minimal mode only (requests and boundaries).`, 'Install Node 24 or newer.');

  out('\nThe project');
  const project = detectProject(root);
  if (project.missing.includes('package')) bad('No package.json or server file (server.js, index.js…) in this folder.', 'Run the command in the app\'s folder, or give the start command: codetac . -- node server.js');
  else if (project.missing.includes('part')) note(`It has several parts: ${project.parts.map(part => part.part).join(', ')}. The command asks which to start.`);
  else if (project.missing.includes('command') && project.top?.language === 'python') {
    if (project.top.python.django) bad('Django project: CodeTAC does not support it yet (FastAPI and Flask only).');
    else bad('Python project, but I did not find the app (FastAPI(...) or Flask(...)) or a command in the Procfile, Makefile or README.', 'Give the command: codetac . -- uvicorn main:app --reload');
  } else if (project.missing.includes('command')) bad('The package.json has no start script (dev, start…).', 'Give the command: codetac . -- <command>');
  for (const part of project.start.length ? project.start : project.parts) {
    if (part.language === 'python') { pythonPart(part, { ok, bad, note }); continue; }
    ok(`Start: ${describeStart(part)}`);
    if (part.port) ok(`Likely port: ${part.port.value} (${part.port.source}). The real port is read when the app starts.`);
    if (!part.installed) bad(`The dependencies of ${part.part === '.' ? 'the project' : part.part} are not installed.`, `${part.manager === 'bun' ? 'npm' : part.manager} install (or codetac --yes, which installs them)`);
    if (part.foreign) note(`The script uses ${part.foreign}, which is not Node: that part runs, but is not observed inside.`);
  }

  out('\nThe panel');
  const panelOn = await ping(panelPort);
  if (panelOn) ok(`Running at http://127.0.0.1:${panelPort}.`);
  else note(`Not running on port ${panelPort}.`, 'The codetac command starts it.');
  try {
    // The running panel's own configuration, else the one it would load.
    const config = (panelOn && await panelConfig(panelPort)) || describeConfig(await loadConfig({ directory }));
    ok(`Purpose sentences: ${config.active ? `${config.model} (${config.provider}${config.local ? ', local: nothing leaves this computer' : ', redacted excerpts are sent'})`
      : `fixed, built from the facts (${config.problem ?? 'no AI model configured'})`}.`);
  } catch {}

  out('\nThe latest recording of this project');
  const [last] = recordingsOf(directory, root);
  if (!last) {
    note('No recordings of this project yet.', 'Start it with: codetac (in the project folder). Then run the diagnosis again.');
    out(problems ? `\n${problems} problem(s) to fix.` : '\nNothing prevents the start.');
    return problems ? 1 : 0;
  }
  const summary = summarize(last.folder);
  // Processes by runtime; a supervisor (reloader) serves nothing and is left out.
  const serving = summary.starts.filter(start => !summary.supervisors.has(start.process));
  const pythons = [...new Set(serving.filter(start => start.python).map(start => start.python))];
  const nodes = serving.filter(start => !start.python).length;
  const runtimes = [nodes && `${nodes} Node`, pythons.length && `${serving.length - nodes} Python ${pythons.join(', ')}`].filter(Boolean).join(', ');
  ok(`${last.name} (${new Date(last.changed).toLocaleString('en-GB')}), ${serving.length} process(es) observed${runtimes ? ` (${runtimes})` : ''}.`);
  if (summary.supervisors.size) ok(`${summary.supervisors.size} reloader supervisor process(es) (they only watch the files; not counted).`);
  if (summary.servers.size) ok(`Server: ${[...summary.servers].join(', ')}.`);
  const minimal = summary.starts.find(start => start.level === 'minimo');
  if (minimal) note(`Minimal mode: the project's functions were not followed (${minimal.reason ?? 'no reason recorded'}). Requests, boundaries and browser were.`,
    'If the app starts without CodeTAC but not with it, send these lines and the start messages.');
  if (summary.ports.size) ok(`Ports opened by the app: ${[...summary.ports].join(', ')}.`);
  else if (!summary.requests) bad('The capture did not see the app open any port.', 'Did the app start? If the server is neither Node nor Python (bun, deno…), it is not observed.');
  if (!minimal) {
    if (summary.files) ok(`Project files prepared: ${summary.files} (${summary.functions} functions).`);
    else if (summary.requests) bad('No project file went through CodeTAC.',
      'The server may be running code already bundled without a source map, or outside the project folder. The dossiers show only requests and boundaries.');
    const failed = summary.failed.length;
    if (failed) {
      note(`${failed} file(s) run without being followed (they could not be prepared):`);
      for (const item of summary.failed.slice(0, 5)) out(`      - ${relative(root, item.file ?? '') || item.file}${item.detail ? `: ${item.detail}` : ''}`);
    }
    for (const [reason, count] of summary.limitations) {
      if (reason === 'module-transform-failed' || reason === 'source-map-unreadable') continue;
      note(`${REASONS[reason] ?? reason}: ${count}.`);
    }
  }
  if (summary.requests) {
    ok(`Requests recorded: ${summary.requests}. With project functions: ${summary.withFunctions.size}. With boundaries: ${summary.withBoundaries.size}.`);
    if (!minimal && summary.files && !summary.withFunctions.size) note('No request has gone through project functions so far.',
      'Normal in a frontend-only app (Vite, static pages): the server only delivers files; what matters is in the browser.');
  } else note('No request has arrived yet.', 'Open the app in the browser and use it.');
  if (summary.pages) ok(`Pages served with the CodeTAC bar: ${summary.pages}.`);
  else if (summary.requests && !summary.actions.size) note('No HTML page went through the observed server: the bar was not injected.',
    'If the page comes from another server (a process CodeTAC does not observe), open it through the app\'s observed server.');
  if (summary.actions.size) ok(`Browser actions recorded: ${summary.actions.size}.`);
  else if (summary.pages) note('The bar is on the page, but no action has arrived yet.', 'Click something in the app. If nothing shows up, check the browser console (CSP errors?).');

  out(problems ? `\n${problems} problem(s) to fix.` : '\nEverything that could be checked is working.');
  return problems ? 1 : 0;
}
