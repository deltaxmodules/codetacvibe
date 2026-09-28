#!/usr/bin/env node
// Python — Etapa 11: every dossier of the Python examples in the panel, with
// the real Chrome at 1280×900 and the fixed sentences (no AI model). Checks
// that the grouped view fits one screen and collects the sentences of the
// templates and of the opaque steps. Uses the recordings of the last
// accept-python.mjs run and of the last browser acceptances of the examples.
//   node scripts/accept-legibilidade-python.mjs
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { launchChrome } from './lib/chrome.mjs';
import { freePort, root, sleep } from './lib/python-apps.mjs';

const WIDTH = 1280;
const HEIGHT = 900;
const data = join(root, '.codetac');

// The recordings: the runs of the last accept-python.mjs report, and the last
// browser acceptance of each example (its recording folder, without -browser).
const report = readdirSync(data).filter(name => /^accept-python-\d.*\.json$/.test(name))
  .sort((a, b) => statSync(join(data, b)).mtimeMs - statSync(join(data, a)).mtimeMs)[0];
const runs = new Set();
(function collect(value) {
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    if (key === 'run' && typeof item === 'string' && existsSync(item)) runs.add(basename(item));
    else collect(item);
  }
})(JSON.parse(readFileSync(join(data, report), 'utf8')).results);
for (const prefix of ['py-flask-browser-', 'py-fastapi-docs-', 'py-misto-proxy-', 'py-misto-sem-proxy-']) {
  const folder = readdirSync(data).filter(name => name.startsWith(prefix) && !name.endsWith('-browser') && existsSync(join(data, name))
    && statSync(join(data, name)).isDirectory()).sort().at(-1);
  if (folder) runs.add(folder);
}

const home = mkdtempSync(join(tmpdir(), 'ctpy-legivel'));
for (const run of runs) cpSync(join(data, run), join(home, run), { recursive: true });
const port = await freePort();
const panel = spawn(process.execPath, [join(root, 'src/panel.mjs'), '--port', String(port)],
  { env: { ...process.env, CODETAC_HOME: home, CODETAC_AI_PROVIDER: 'none' }, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
const out = join(data, `legibilidade-python-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(out, { recursive: true });
const results = [];
const sentences = [];
let chrome;
try {
  for (let waited = 0; ; waited += 100) {
    try { await fetch(`${base}/api/ping`); break; } catch { if (waited > 10000) throw new Error('o painel não arrancou'); await sleep(100); }
  }
  const targets = [];
  for (const run of runs) {
    for (const request of await (await fetch(`${base}/api/requests?run=${encodeURIComponent(run)}&limit=500`)).json()) {
      if (request.functions || request.boundaries) targets.push({ kind: 'request', id: request.requestId, run, label: `${request.method} ${request.path}` });
    }
    for (const action of await (await fetch(`${base}/api/actions?run=${encodeURIComponent(run)}&limit=200`)).json()) {
      targets.push({ kind: 'action', id: action.actionId, run, label: action.label });
    }
  }
  // The fixed sentences of templates and opaque steps, from the digest.
  const walk = (nodes, visit) => { for (const node of nodes ?? []) { visit(node); walk(node.children, visit); } };
  for (const target of targets.filter(item => item.kind === 'request')) {
    const dossier = await (await fetch(`${base}/api/requests/${encodeURIComponent(target.id)}`)).json();
    walk(dossier.digest?.nodes, node => {
      if (node.type === 'function' && (node.opaque || /\.html$/.test(node.file ?? ''))) {
        sentences.push({ run: target.run, request: target.label, function: node.function, where: node.file ? `${basename(node.file)}:${node.line ?? '—'}` : '—',
          opaque: Boolean(node.opaque), sentence: node.purpose?.text });
      }
    });
  }
  chrome = await launchChrome({ width: WIDTH, height: HEIGHT, scratch: out });
  for (const target of targets) {
    const page = await chrome.newPage();
    await page.call('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await page.goto(`${base}/?embed=1&${target.kind}=${encodeURIComponent(target.id)}`);
    await page.waitFor(`!!document.querySelector('section.effects')`, 60000);
    const measure = await page.evaluate(`(() => {
      const detail = document.getElementById('detail');
      const top = detail.querySelector('h2').getBoundingClientRect().top + detail.scrollTop;
      const bottom = document.querySelector('section.effects').getBoundingClientRect().bottom + detail.scrollTop;
      return { height: Math.round(bottom - top), rows: [...detail.querySelectorAll('.step, .cross')].filter(e => e.offsetParent !== null).length,
        all: detail.querySelectorAll('.step').length };
    })()`);
    const file = join(out, `${target.kind}-${target.id.replace(/[^\w.-]/g, '_')}.png`);
    writeFileSync(file, await page.screenshot());
    results.push({ ...target, ...measure, fits: measure.height <= HEIGHT, consoleErrors: page.errors.length, screenshot: file });
    await page.call('Page.close').catch(() => {});
  }
} finally {
  if (chrome) await chrome.close();
  panel.kill();
  rmSync(home, { recursive: true, force: true });
}

writeFileSync(join(out, 'legibilidade.json'), JSON.stringify({ runs: [...runs], results, sentences }, null, 2));
const fit = results.filter(item => item.fits).length;
console.log(`Gravações: ${runs.size}; dossiers medidos: ${results.length} (${results.filter(item => item.kind === 'request').length} pedidos, ${results.filter(item => item.kind === 'action').length} ações)`);
console.log(`Cabem num ecrã de ${WIDTH}×${HEIGHT}: ${fit} de ${results.length}; maior: ${Math.max(...results.map(item => item.height))} px`);
for (const item of results.filter(entry => !entry.fits)) console.log(`  NÃO CABE: ${item.kind} ${item.label} (${item.run}): ${item.height} px, ${item.rows} linhas`);
console.log(`Erros na consola do painel: ${results.reduce((total, item) => total + item.consoleErrors, 0)}`);
const unique = new Map();
for (const item of sentences) unique.set(`${item.function}|${item.where}|${item.sentence}`, item);
console.log('\nFrases fixas dos templates e dos passos opacos:');
for (const item of unique.values()) console.log(`  ${item.opaque ? '[opaco] ' : ''}${item.function} (${item.where}): «${item.sentence}»`);
console.log(`\nRelatório: ${join(out, 'legibilidade.json')}`);
if (fit !== results.length) process.exitCode = 1;
