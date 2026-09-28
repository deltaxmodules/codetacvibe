// Aceitação da Fase 2 num projeto: conduz o Chrome real (cliques e teclado
// verdadeiros) por um cenário, primeiro sem captura (referência) e depois com
// captura, e verifica os critérios:
//   - um clique produz um dossier único, com a parte do browser e a do servidor;
//   - uma ação com vários pedidos aparece como uma só ação;
//   - uma ação só de frontend produz dossier;
//   - a barra não altera a disposição da página nem acrescenta erros na consola.
// Procura ainda segredos conhecidos nas gravações e confirma que o projeto não
// foi alterado (git status igual antes e depois).
// Com "python" (o interpretador, por exemplo "{root}/.venv/bin/python"), a app
// é Python e a captura entra pelo captor Python (src/python/codetac_py).
//   node scripts/accept-browser.mjs <config.json>
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { launchChrome } from './lib/chrome.mjs';
import { openStore } from '../src/store.mjs';
import { createActionView } from '../src/action-view.mjs';
import { digestAction } from '../src/digest.mjs';

const workspace = resolve(import.meta.dirname, '..');
const config = JSON.parse(readFileSync(resolve(process.argv[2] ?? ''), 'utf8'));
const root = resolve(config.root.replace('{codetac}', resolve(import.meta.dirname, '..')));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const label = `${config.name}-${stamp}`;
const outputDir = join(workspace, '.codetac', `${label}-browser`);
mkdirSync(outputDir, { recursive: true, mode: 0o700 });
const secrets = config.secretsFile ? JSON.parse(readFileSync(resolve(config.secretsFile), 'utf8')) : {};
const found = {};
const substitute = value => typeof value === 'string'
  ? value.replace(/\{(\w+)\}/g, (match, name) => ({ root, codetac: workspace, out: outputDir }[name] ?? match))
    .replace(/\$([A-Za-z0-9_]+)/g, (match, name) => secrets[name] ?? found[name] ?? process.env[name] ?? match) : value;

async function freePort() {
  const server = createServer();
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address();
  await new Promise(ok => server.close(ok));
  return port;
}
function gitStatus() {
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout : null;
}

// Starts a process in its own group; stop() ends the whole group.
function start(args, env, cwd = root, command = process.execPath) {
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output = (output + data).slice(-64000); });
  child.stderr.on('data', data => { output = (output + data).slice(-64000); });
  return {
    child, output: () => output,
    async stop() {
      if (child.exitCode !== null) return;
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      await Promise.race([new Promise(ok => child.once('exit', ok)), delay(8000)]);
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    },
  };
}

// One process of the scenario, with or without capture: the app itself, or a
// companion (for example the Python API next to a Vite frontend). `ports`
// holds every port of the scenario: {port} is the app's, {<name>} a companion's.
async function startProcess(spec, directory, capture, ports, own) {
  const fill = value => Object.entries(ports).reduce((text, [name, number]) => text.replaceAll(`{${name}}`, String(number)), substitute(String(value)));
  const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1', PORT: String(ports[own]) };
  for (const key of Object.keys(env)) if (key.startsWith('CODETAC_') || key === 'PYTHONPATH') delete env[key];
  delete env.NODE_OPTIONS;
  // A companion with "capture": false runs unobserved (for example, an API
  // started without CodeTAC).
  if (capture && spec.capture !== false) Object.assign(env, { CODETAC_ROOT: directory, CODETAC_RUN: label, CODETAC_PANEL_PORT: String(panelPort) },
    spec.python ? { PYTHONPATH: join(workspace, 'src/python/codetac_py'), PYTHONDONTWRITEBYTECODE: '1' }
      : { NODE_OPTIONS: `--import=${pathToFileURL(join(workspace, 'src/register.mjs')).href}` });
  for (const [key, value] of Object.entries(spec.env ?? {})) env[key] = fill(value);
  const app = start(spec.args.map(fill), env, directory, spec.python ? substitute(spec.python) : process.execPath);
  const origin = fill(spec.origin ?? 'http://localhost:{port}');
  const began = performance.now();
  while (true) {
    if (performance.now() - began > 240000) throw new Error('servidor não ficou pronto em 240 s');
    if (app.child.exitCode !== null) throw new Error(`servidor terminou (${app.child.exitCode})\n${app.output().slice(-2000)}`);
    try { await fetch(`${origin}${spec.readyPath ?? '/'}`, { redirect: 'manual', signal: AbortSignal.timeout(90000) }); break; }
    catch { await delay(300); }
  }
  return { ...app, origin };
}

async function startApp(capture) {
  // Optional preparation before each run (for example, resetting a test database).
  for (const command of config.prepare ?? []) {
    const result = spawnSync(process.execPath, command.map(substitute), { cwd: root, encoding: 'utf8', env: process.env });
    if (result.status !== 0) throw new Error(`preparação falhou: ${result.stderr.slice(-500)}`);
  }
  const ports = { port: await freePort() };
  for (const companion of config.companions ?? []) ports[companion.name] = await freePort();
  const companions = [];
  try {
    for (const companion of config.companions ?? []) {
      companions.push(await startProcess({ ...companion, origin: companion.origin ?? `http://127.0.0.1:{${companion.name}}` },
        resolve(substitute(companion.root)), capture, ports, companion.name));
    }
    const app = await startProcess(config, root, capture, ports, 'port');
    return { ...app, port: ports.port, async stop() { await app.stop(); for (const companion of companions) await companion.stop(); } };
  } catch (error) {
    for (const companion of companions) await companion.stop();
    throw error;
  }
}

// One pass through the scenario. With capture, each "action" step records the
// ids of the actions it produced (from the store, by time window).
async function scenario(page, app, capture, store) {
  const result = { steps: [], layouts: {}, screenshots: [] };
  for (const [index, step] of config.steps.entries()) {
    const entry = { index, step: step.name ?? Object.keys(step)[0] };
    const begin = Date.now();
    try {
      if (step.goto) await page.goto(`${app.origin}${substitute(step.goto)}`);
      if (step.gotoFromFile) {
        const text = readFileSync(substitute(step.gotoFromFile.file), 'utf8').replace(/=\r?\n/g, '').replace(/=3D/g, '=');
        const match = text.match(new RegExp(step.gotoFromFile.pattern));
        if (!match) throw new Error('link não encontrado no ficheiro');
        if (step.gotoFromFile.secret) found[step.gotoFromFile.secret] = match[1] ?? match[0];
        const url = new URL(match[0]);
        await page.goto(`${app.origin}${url.pathname}${url.search}`);
      }
      if (step.waitFor) await page.waitFor(step.waitFor, step.timeout ?? 30000);
      // Detail on request (Phase 4), as the panel asks for it: written to the
      // recording's folder while the application runs.
      if (step.detail) {
        if (capture) {
          const spec = JSON.parse(substitute(JSON.stringify(step.detail)));
          writeFileSync(join(workspace, '.codetac', label, 'detalhe.json'), JSON.stringify(spec));
          await delay(1200);
        }
      }
      if (step.type) await page.type(step.type[0], substitute(step.type[1]));
      // Replaces the whole text of a field, as a person would (select all, then type).
      if (step.replace) {
        await page.click(step.replace[0]);
        await page.evaluate(`document.querySelector(${JSON.stringify(step.replace[0])}).select()`);
        await page.call('Input.insertText', { text: substitute(step.replace[1]) });
      }
      if (step.click) await page.click(step.click);
      if (step.after) await page.waitFor(step.after, step.timeout ?? 30000);
      if (step.settle) await delay(step.settle);
      if (step.click && capture) await delay(1200);
      // Opens the bar's dossier (as a person would) and photographs the page.
      if (step.openBar && capture) {
        await page.waitFor('window.__codetac && window.__codetac.recorded.length > 0', 20000);
        const box = await page.evaluate(`(() => { const r = document.querySelector('codetac-bar').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
        await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
        await delay(step.openBar === true ? 4000 : step.openBar);
        const png = join(outputDir, `barra-${index}.png`);
        writeFileSync(png, await page.screenshot());
        result.screenshots.push(png);
      }
      if (step.snapshot) {
        await delay(step.settle ? 0 : 800);
        result.layouts[step.snapshot] = await page.layout();
        const png = join(outputDir, `${capture ? 'com' : 'sem'}-captura-${step.snapshot}.png`);
        writeFileSync(png, await page.screenshot());
        result.screenshots.push(png);
      }
      entry.ok = true;
    } catch (error) {
      entry.ok = false;
      entry.error = String(error.message).slice(0, 500);
    }
    if (capture && step.expect) {
      entry.actions = await actionsSince(store, begin, step);
    }
    result.steps.push(entry);
    if (!entry.ok && !step.optional) break;
  }
  result.errors = [...page.errors];
  if (capture) result.bar = await page.evaluate('Boolean(document.querySelector("codetac-bar"))').catch(() => false);
  return result;
}

// Actions of this recording that started during the step, once closed.
async function actionsSince(store, begin, step) {
  const deadline = Date.now() + (step.wait ?? 20000);
  let previous = null;
  let all = [];
  // Done when the actions stop changing (a new page adds a segment later).
  while (Date.now() < deadline) {
    await delay(700);
    store.ingest();
    all = store.listActions({ run: label, limit: 50 }).filter(item => item.at >= begin - 50);
    const state = JSON.stringify(all.map(item => [item.actionId, item.segments, item.serverRequests, item.pending]));
    if (all.length && all.every(item => !item.pending) && state === previous) break;
    previous = state;
  }
  return all.map(item => item.actionId);
}

function checkAction(dossier, expect) {
  const timeline = dossier.timeline;
  const serverParts = timeline.flatMap(item => item.server ?? []);
  const browserRequests = timeline.filter(item => item.type === 'request');
  const screens = timeline.filter(item => item.type === 'screen');
  const trigger = timeline.find(item => item.type === 'trigger');
  const functions = serverParts.reduce((total, part) => total + part.steps.filter(step => step.type === 'function').length, 0);
  const screenChanged = screens.some(({ screen: s }) => (s.added || 0) + (s.removed || 0) + (s.text || 0) + (s.attributes || 0)
    + (s.stateChanged?.length || 0) + (s.mounted?.length || 0) > 0);
  const checks = {
    browserPart: Boolean(trigger) && screens.length > 0,
    component: Boolean(trigger?.trigger.component?.origin?.project || trigger?.trigger.component?.project),
    // Every same-origin browser request found its server part, and no server
    // request of the action is left without its browser counterpart.
    linked: browserRequests.filter(item => item.browser.sameOrigin).every(item => item.server.length > 0)
      && !timeline.some(item => item.type === 'unmatched'),
    serverPart: serverParts.length > 0 && functions > 0,
    requests: serverParts.length,
    frontendOnly: browserRequests.length === 0 && serverParts.length === 0 && screenChanged,
    dbWrite: serverParts.some(part => part.steps.some(step => step.type === 'boundary' && step.kind === 'base-de-dados'
      && /^(INSERT|UPDATE|DELETE|UPSERT|REPLACE)$/.test(step.operation))),
    finished: !dossier.pending,
    detail: serverParts.flatMap(part => part.steps.filter(step => step.type === 'function' && step.detail)
      .map(step => ({ function: step.function, line: step.line, args: step.detail.args.length, returned: 'returned' in step.detail, lines: step.detail.lines.length }))),
  };
  const failed = [];
  if (!checks.browserPart) failed.push('browserPart');
  if (!checks.finished) failed.push('finished');
  if (expect.component && !checks.component) failed.push('component');
  if (expect.server) { if (!checks.serverPart) failed.push('serverPart'); if (!checks.linked) failed.push('linked'); }
  if (expect.requestsMin && checks.requests < expect.requestsMin) failed.push(`requests>=${expect.requestsMin}`);
  if (expect.frontendOnly && !checks.frontendOnly) failed.push('frontendOnly');
  if (expect.dbWrite && !checks.dbWrite) failed.push('dbWrite');
  // Values only for the functions asked for, and recorded for each of them.
  if (expect.detail) {
    const names = [...new Set(checks.detail.map(item => item.function))].sort();
    if (JSON.stringify(names) !== JSON.stringify([...expect.detail].sort())) failed.push(`detalhe=${names.join(',') || 'nenhum'} (esperado ${expect.detail.join(',')})`);
    if (checks.detail.some(item => !item.lines)) failed.push('detalhe sem linhas executadas');
  }
  if (expect.noDetail && checks.detail.length) failed.push('detalhe antes de ser pedido');
  // Functions of the project that must be in the server part, and the text
  // expected on the line each one is shown at (templates: the .html line).
  const steps = serverParts.flatMap(part => part.steps.filter(step => step.type === 'function'));
  checks.functions = [...new Set(steps.map(step => step.function))];
  for (const name of expect.functions ?? []) if (!checks.functions.includes(name)) failed.push(`função ${name}`);
  checks.lines = {};
  for (const [name, text] of Object.entries(expect.lines ?? {})) {
    const step = steps.find(item => item.function === name);
    const line = step?.line ? readFileSync(step.file, 'utf8').split('\n')[step.line - 1] : undefined;
    checks.lines[name] = step ? `${step.file.slice(root.length + 1)}:${step.line} ${line?.trim() ?? '(sem linha)'}` : null;
    if (!line?.includes(text)) failed.push(`linha de ${name}`);
  }
  // DP3: requests to another origin linked as probable, with their server part.
  const cross = browserRequests.filter(item => !item.browser.sameOrigin);
  checks.probable = cross.map(item => ({ path: item.browser.path, host: item.browser.host, probable: Boolean(item.probable), requests: item.server.length }));
  if (expect.probable && !(cross.length && cross.every(item => item.probable && item.server.length))) failed.push('ligação provável');
  if (expect.unlinked && !(cross.length && cross.every(item => !item.probable && !item.server.length))) failed.push('sem ligação');
  // Lasting effects that must be in the action's summary (all its requests,
  // work after the response included).
  checks.effects = digestAction(dossier).effects.items.map(item => item.text);
  for (const text of expect.effects ?? []) if (!checks.effects.includes(text)) failed.push(`efeito «${text}»`);
  checks.afterResponse = steps.filter(step => step.afterResponse).map(step => step.function);
  for (const name of expect.afterResponse ?? []) if (!checks.afterResponse.includes(name)) failed.push(`depois da resposta: ${name}`);
  const handlers = [trigger?.trigger.handler, trigger?.trigger.submit?.handler].filter(Boolean).map(handler => handler.name);
  checks.handlers = handlers;
  if (expect.handler && !handlers.includes(expect.handler)) failed.push(`handler=${expect.handler}`);
  // Frames that must appear on the way to a request (browser functions).
  const chain = timeline.filter(item => item.type === 'request').flatMap(item => (item.browser.chain ?? []).map(frame => `${frame.fn}@${frame.short}:${frame.line}`));
  checks.chain = chain;
  for (const expected of expect.chain ?? []) if (!chain.some(frame => frame.startsWith(expected))) failed.push(`chain~${expected}`);
  checks.segments = timeline.filter(item => item.type === 'document').length + 1;
  if (expect.segments && checks.segments !== expect.segments) failed.push(`segments=${expect.segments}`);
  return { checks, failed };
}

// A readable outline of the dossier, for the report and the terminal.
function outline(dossier) {
  const lines = [];
  const short = file => file?.startsWith(root) ? file.slice(root.length + 1) : file;
  for (const item of dossier.timeline) {
    if (item.type === 'trigger') {
      const c = item.trigger.component;
      const place = c?.origin?.project ? c.origin : c?.project?.origin;
      lines.push(`[browser] ${item.trigger.event} ${dossier.label}${c?.name ? ` · ${c.name}` : ''}${c?.project ? ` (biblioteca, via ${c.project.via} em ${c.project.name ?? '?'})` : ''}${place ? ` ${place.short}:${place.line}` : ''}`);
      for (const h of [item.trigger.handler, item.trigger.submit?.handler].filter(Boolean)) lines.push(`    handler ${h.name} (${h.prop ?? h.source})`);
    } else if (item.type === 'request') {
      const b = item.browser;
      lines.push(`  [browser→${b.sameOrigin ? 'servidor' : b.host}${item.probable ? ', ligação provável' : ''}] ${b.method} ${b.path} → ${b.status ?? '—'}${b.chain?.length ? `  ← ${b.chain.map(f => `${f.fn} ${f.short}:${f.line}`).join(' → ')}` : ''}`);
      for (const part of item.server) partLines(part);
    } else if (item.type === 'document') {
      lines.push(`  [nova página] ${item.page?.path}`);
      for (const part of item.server) partLines(part);
    } else if (item.type === 'navigation') {
      lines.push(`  [navegação] ${item.kind} → ${item.path}`);
    } else if (item.type === 'screen') {
      const s = item.screen;
      const own = list => (list ?? []).filter(c => c.origin?.project).map(c => c.name);
      lines.push(`  [ecrã] +${s.added ?? 0} −${s.removed ?? 0} texto ${s.text ?? 0} atributos ${s.attributes ?? 0}` +
        `${own(s.stateChanged).length ? ` · estado: ${own(s.stateChanged).join(', ')}` : ''}${own(s.mounted).length ? ` · apareceu: ${own(s.mounted).join(', ')}` : ''} (${item.closedBy})`);
    } else if (item.type === 'unmatched') {
      lines.push('  [servidor sem registo no browser]');
      for (const part of item.server) partLines(part);
    }
  }
  function partLines(part) {
    lines.push(`      servidor: ${part.request.method} ${part.request.path} → ${part.request.status}`);
    for (const step of part.steps.slice(0, 60)) {
      const indent = '        ' + '  '.repeat(Math.min(step.depth, 8));
      lines.push(step.type === 'function' ? `${indent}${step.function}  ${short(step.file)}:${step.line}`
        : `${indent}[${step.kind}] ${step.provider ?? step.library ?? ''} ${step.operation ?? step.method ?? ''} ${step.tables?.join(',') ?? step.host ?? ''}`);
    }
    if (part.steps.length > 60) lines.push(`        … mais ${part.steps.length - 60} passos`);
  }
  lines.push(`  Marcas: ${dossier.marks.map(mark => (mark.count > 1 ? `${mark.count} × ` : '') + mark.label).join('; ') || 'nenhuma'}`);
  return lines;
}

const normalize = text => String(text).replace(/https?:\/\/[^\s)]+/g, 'URL').replace(/\d+/g, 'N');
function compareLayouts(reference, captured) {
  const result = {};
  for (const [name, before] of Object.entries(reference)) {
    const after = captured[name];
    if (!after) { result[name] = { equal: false, reason: 'sem captura desta vista' }; continue; }
    const differences = [];
    const count = Math.max(before.items.length, after.items.length);
    for (let i = 0; i < count; i++) {
      if (JSON.stringify(before.items[i]) !== JSON.stringify(after.items[i])) differences.push({ reference: before.items[i], captured: after.items[i] });
    }
    result[name] = { equal: differences.length === 0 && before.count === after.count && JSON.stringify(before.scroll) === JSON.stringify(after.scroll),
      elements: [before.count, after.count], scroll: [before.scroll, after.scroll], differences: differences.slice(0, 10) };
  }
  return result;
}

const statusBefore = gitStatus();
const report = { date: new Date().toISOString(), project: config.name, run: label, root, passed: true };
const services = (config.services ?? []).map(service => start(service.args.map(substitute), process.env, workspace));
// The panel serves the dossier that the bar shows inside the page.
const panelPort = await freePort();
services.push(start([join(workspace, 'src/panel.mjs'), '--port', String(panelPort)], process.env, workspace));
const chrome = await launchChrome({ scratch: outputDir });
let captured;
try {
  if (config.baseline !== false) {
    const app = await startApp(false);
    try {
      const page = await chrome.newPage();
      report.reference = await scenario(page, app, false);
      await page.call('Page.close').catch(() => {});
    } finally { await app.stop(); }
    console.log(`Referência sem captura: ${report.reference.steps.filter(step => step.ok).length}/${report.reference.steps.length} passos; ${report.reference.errors.length} erros na consola`);
  }
  const app = await startApp(true);
  const store = openStore(join(workspace, '.codetac'));
  const view = createActionView(store);
  try {
    const page = await chrome.newPage();
    captured = await scenario(page, app, true, store);
    // Dossiers are resolved while the application still serves its source maps.
    report.actions = [];
    for (const [index, step] of config.steps.entries()) {
      if (!step.expect) continue;
      const entry = captured.steps.find(item => item.index === index);
      const ids = entry?.actions ?? [];
      const item = { step: step.name ?? `passo ${index}`, expect: step.expect, stepOk: Boolean(entry?.ok), actions: ids.length };
      const failed = [];
      if (!entry?.ok) failed.push('passo falhou');
      if (ids.length !== 1) failed.push(`ações=${ids.length} (esperada 1)`);
      if (ids.length) {
        const dossier = await view.resolvedAction(ids[0]);
        const checked = checkAction(dossier, step.expect);
        failed.push(...checked.failed);
        Object.assign(item, { actionId: ids[0], label: dossier.label, checks: checked.checks, outline: outline(dossier) });
        writeFileSync(join(outputDir, `acao-${index}.json`), JSON.stringify(dossier, null, 2), { mode: 0o600 });
      }
      item.failed = failed;
      item.passed = failed.length === 0;
      if (!item.passed) report.passed = false;
      report.actions.push(item);
    }
    await page.call('Page.close').catch(() => {});
  } finally {
    await app.stop();
    store.close();
  }
  report.captured = { steps: captured.steps, errors: captured.errors, bar: captured.bar, screenshots: captured.screenshots };
  if (!captured.bar) report.passed = false;
  if (report.reference) {
    report.layout = compareLayouts(report.reference.layouts, captured.layouts);
    const known = new Set(report.reference.errors.map(error => normalize(error.text)));
    report.newErrors = captured.errors.filter(error => !known.has(normalize(error.text)));
    const referenceOk = report.reference.steps.map(step => step.ok);
    report.sameBehaviour = captured.steps.every((step, index) => step.ok === referenceOk[index]);
    if (Object.values(report.layout).some(item => !item.equal) || report.newErrors.length || !report.sameBehaviour) report.passed = false;
  }
} finally {
  await chrome.close();
  for (const service of services) await service.stop();
}

// Known secrets: sensitive values from the project's env files, the
// credentials used, and values found during the scenario (login links).
const sensitive = /password|secret|token|authorization|api[ _-]?key|apikey|credential|private[ _-]?key|session/i;
const values = new Set([...Object.values(secrets), ...Object.values(found)].filter(value => typeof value === 'string' && value.length >= 6));
for (const file of config.envFiles ?? []) {
  const path = join(root, file);
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index < 0 || line.trim().startsWith('#')) continue;
    const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, '');
    if (sensitive.test(line.slice(0, index)) && value.length >= 8) values.add(value);
  }
}
for (const value of config.extraSecrets ?? []) values.add(value);
const recordings = join(workspace, '.codetac', label);
const texts = existsSync(recordings) ? readdirSync(recordings).filter(name => name.endsWith('.jsonl')).map(name => readFileSync(join(recordings, name), 'utf8')) : [];
report.secretsChecked = values.size;
report.secretsFound = [...values].filter(value => texts.some(text => text.includes(value))).map(value => `valor com ${value.length} caracteres`);
if (report.secretsFound.length) report.passed = false;
report.projectUnchanged = gitStatus() === statusBefore;
if (!report.projectUnchanged) report.passed = false;

const file = join(outputDir, 'aceitacao.json');
writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });
for (const item of report.actions ?? []) {
  console.log(`\n${item.step}: ${item.passed ? 'ACEITE' : `FALHOU (${item.failed.join(', ')})`}`);
  for (const line of item.outline ?? []) console.log(`  ${line}`);
}
if (report.layout) {
  for (const [name, item] of Object.entries(report.layout)) console.log(`\nDisposição «${name}»: ${item.equal ? 'igual' : 'DIFERENTE'} (${item.elements?.join(' / ')} elementos)`);
  console.log(`Erros novos na consola: ${report.newErrors.length}${report.newErrors.length ? ' — ' + report.newErrors.map(error => error.text).join(' | ') : ''}`);
  console.log(`Mesmo comportamento que sem captura: ${report.sameBehaviour ? 'sim' : 'NÃO'}`);
}
console.log(`Barra presente: ${captured?.bar ? 'sim' : 'NÃO'}; projeto inalterado: ${report.projectUnchanged ? 'sim' : 'NÃO'}`);
console.log(`Segredos verificados: ${report.secretsChecked}; encontrados: ${report.secretsFound.length}`);
console.log(`Resultado: ${report.passed ? 'ACEITE' : 'FALHOU'} — ${file}`);
if (!report.passed) process.exitCode = 1;
