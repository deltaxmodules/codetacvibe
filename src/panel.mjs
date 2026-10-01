// Painel: lista as ações do browser (Fase 2) e os pedidos gravados (Fase 1) e
// mostra, para cada um, a vista agrupada com frases de finalidade (Fase 3), a
// sequência completa por expansão e o código de cada função.
// Uso: node src/panel.mjs [--port 4000]
import http from 'node:http';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, sep, isAbsolute } from 'node:path';
import { openStore } from './store.mjs';
import { dataDirectory } from './home.mjs';
import { createActionView } from './action-view.mjs';
import { digestAction, digestRequest } from './digest.mjs';
import { LABELS } from './sentences.mjs';
import { answerQuestion, complete, createPurposes, describeConfig, loadConfig, questionRequest } from './ai.mjs';
import { blocked, blockedText, clearLog, privacyState, readLog, writeSettings } from './privacy.mjs';
import { createStructureService, isLoopback } from './structure/service.mjs';
import { TEXT, t, privacyPageWithText, planPageWithText } from './structure/text.mjs';
import { maskKeys } from './structure/node/modules.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const directory = dataDirectory();
const portIndex = process.argv.indexOf('--port');
const port = Number(portIndex > 0 ? process.argv[portIndex + 1] : process.env.CODETAC_PANEL_PORT || 4000);
const store = openStore(directory, { keep: Number(process.env.CODETAC_KEEP || 500) });

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

// Only files inside the observed project of that recording can be shown.
function source(run, file, line, endLine) {
  const root = store.root(run);
  if (!root || !file || !isAbsolute(file)) return null;
  let real;
  try { real = realpathSync(file); } catch { return null; }
  const within = relative(realpathSync(root), real);
  if (within === '' || within.startsWith(`..${sep}`) || within === '..' || isAbsolute(within) || within.split(sep).includes('node_modules')) return null;
  // Never hidden files (.env and similar), and only files with recorded functions.
  if (within.split(sep).some(part => part.startsWith('.') && part !== '.next')) return null;
  if (!store.recordedFile(run, file) && !view.browserFile(run, real)) return null;
  // A step without a line (opaque) has no code to show.
  if (!Number.isFinite(line) || line < 1) return null;
  const lines = readFileSync(real, 'utf8').split('\n');
  const start = Math.max(1, line);
  const end = Math.min(lines.length, endLine && endLine >= start ? Math.min(endLine, start + 400) : start + 40);
  // Keys written in the code are masked, here as in the structure (principle 4).
  return { file: within, start, end, lines: lines.slice(start - 1, end).map(maskKeys) };
}

const view = createActionView(store);
const ai = await loadConfig({ directory });
const purposes = ai.provider ? createPurposes({ config: ai, cache: store.purposeCache, readCode: source }) : null;
if (ai.provider && blocked('purposes', ai)) console.log(`Purpose sentences: fixed, built from the facts (${ai.model}: ${blockedText(blocked('purposes', ai))})`);
else if (ai.provider) console.log(`Purpose sentences: ${ai.model} (${ai.provider}${ai.local ? ', local: nothing leaves this computer' : ', redacted excerpts are sent'}).`);
else console.log(`Purpose sentences: fixed, built from the facts${ai.problem ? ` (${ai.problem})` : ' (no AI model configured)'}.`);

// Editor links (Phase 4): CODETAC_EDITOR = vscode (default), cursor, windsurf, none.
const EDITORS = { vscode: 'vscode', cursor: 'cursor', windsurf: 'windsurf', vscodium: 'vscodium' };
const editor = String(process.env.CODETAC_EDITOR ?? 'vscode').toLowerCase();
const editorScheme = EDITORS[editor] ?? null;

// The project's structure (StructureTAC): the folder of each recording.
const privacyPage = privacyPageWithText(readFileSync(new URL('./privacy-page.html', import.meta.url), 'utf8'));
const structurePage = planPageWithText(readFileSync(new URL('./structure/plan-page.html', import.meta.url), 'utf8'));
const structure = createStructureService({ rootOf: run => { store.ingest(); return store.root(run); }, editor: editorScheme, ai: { config: ai, complete },
  recordings: { actions: run => { store.ingest(); return store.listActions({ run, limit: 50 }); }, action: id => view.resolvedAction(id), request: id => requestWithDigest(id),
    outgoing: run => { store.ingest(); return store.outgoing(run); } } });

// Detail requests live in the recording's folder, where the running
// application reads them (runtime.mjs).
function detailPath(run) {
  if (!/^[\w.-]+$/.test(run ?? '') || !existsSync(join(directory, run))) return null;
  return join(directory, run, 'detalhe.json');
}
function readDetail(run) {
  const path = detailPath(run);
  if (!path) return null;
  try { return { functions: [], files: [], ...JSON.parse(readFileSync(path, 'utf8')) }; } catch { return { functions: [], files: [] }; }
}
async function body(request) {
  let text = '';
  for await (const chunk of request) { text += chunk; if (text.length > 100_000) throw new Error(t('panel.api.tooLarge')); }
  return JSON.parse(text || '{}');
}

async function actionWithDigest(id) {
  const dossier = await view.resolvedAction(id);
  if (dossier) dossier.digest = digestAction(dossier);
  return dossier;
}
function requestWithDigest(id) {
  store.ingest();
  const dossier = store.dossier(id);
  if (dossier) dossier.digest = digestRequest(dossier);
  return dossier;
}

const server = http.createServer(async (request, response) => {
  // Local only: a page served from another name (DNS rebinding) is refused.
  if (!new Set([`127.0.0.1:${port}`, `localhost:${port}`]).has(request.headers.host)) {
    json(response, 403, { error: t('panel.api.localOnly') });
    return;
  }
  const url = new URL(request.url, 'http://localhost');
  try {
    if (url.pathname === '/') {
      // The page may be framed only by local pages (the bar in the application).
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "frame-ancestors 'self' http://localhost:* http://127.0.0.1:* http://*.localhost:*" });
      response.end(page);
      return;
    }
    if (url.pathname === '/structure') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "frame-ancestors 'self' http://localhost:* http://127.0.0.1:* http://*.localhost:*" });
      response.end(structurePage);
      return;
    }
    if (url.pathname === '/privacy') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "frame-ancestors 'self' http://localhost:* http://127.0.0.1:* http://*.localhost:*" });
      response.end(privacyPage);
      return;
    }
    if (url.pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.pathname === '/api/ping') {
      // The version lets a newer codetac refuse to reuse an older panel.
      json(response, 200, { ok: true, version: VERSION, pid: process.pid });
      return;
    }
    if (url.pathname === '/api/runs') {
      store.ingest();
      json(response, 200, store.listRuns());
      return;
    }
    if (url.pathname === '/api/requests') {
      store.ingest();
      json(response, 200, store.listRequests({ limit: Number(url.searchParams.get('limit') || 200), run: url.searchParams.get('run') || undefined,
        withoutAction: url.searchParams.get('semAcao') === '1' }));
      return;
    }
    if (url.pathname === '/api/actions') {
      store.ingest();
      json(response, 200, store.listActions({ limit: Number(url.searchParams.get('limit') || 200), run: url.searchParams.get('run') || undefined }));
      return;
    }
    // Structure: read-only (the POSTs ask the AI, save a snapshot, a quiz answer or a reviewed change outside the project),
    // and only for the panel's own pages on this computer.
    if (url.pathname === '/api/structure' || url.pathname.startsWith('/api/structure/')) {
      const post = request.method === 'POST' && ['/api/structure/explain', '/api/structure/snapshot', '/api/structure/quiz/answer', '/api/structure/review'].includes(url.pathname);
      if ((request.method !== 'GET' && !post) || (post && request.headers['x-codetac'] !== '1') || !isLoopback(request.socket.remoteAddress)
        || (request.headers.origin && !new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]).has(request.headers.origin))
        || (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site']))) {
        json(response, 403, { error: t('panel.api.refused') });
        return;
      }
      const answer = await structure.handle(url.pathname, url.searchParams, post ? { method: 'POST', body: await body(request) } : {});
      json(response, answer.status, answer.body);
      return;
    }
    if (url.pathname === '/api/config') {
      json(response, 200, { ...describeConfig(ai), editor: editorScheme });
      return;
    }
    // Changes are accepted only from the panel itself: a custom header (which
    // a page elsewhere cannot send without a preflight) and a local origin.
    if (request.method === 'POST' && (request.headers['x-codetac'] !== '1'
      || (request.headers.origin && !new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]).has(request.headers.origin)))) {
      json(response, 403, { error: t('panel.api.refused') });
      return;
    }
    if (url.pathname === '/api/detalhe') {
      const run = request.method === 'POST' ? null : url.searchParams.get('run');
      if (request.method !== 'POST') {
        const spec = readDetail(run);
        json(response, spec ? 200 : 404, spec ?? { error: t('panel.api.unknownRecording') });
        return;
      }
      const change = await body(request);
      const spec = readDetail(change.run);
      if (!spec) { json(response, 404, { error: t('panel.api.unknownRecording') }); return; }
      const same = item => item.file === change.file && item.line === change.line && (item.function ?? '') === (change.function ?? '');
      if (change.op === 'limpar') { spec.functions = []; spec.files = []; }
      else if (change.op === 'ficheiro') spec.files = spec.files.includes(change.file) ? spec.files.filter(file => file !== change.file) : [...spec.files, change.file];
      else if (change.op === 'funcao') spec.functions = spec.functions.some(same) ? spec.functions.filter(item => !same(item))
        : [...spec.functions, { file: change.file, line: change.line, function: change.function }];
      spec.updatedAt = Date.now();
      writeFileSync(detailPath(change.run), JSON.stringify(spec, null, 2));
      json(response, 200, spec);
      return;
    }
    // Privacy (StructureTAC phase 10, step 5): the switches, «No AI» and the log of what was sent.
    if (url.pathname === '/api/privacy') {
      if (request.method === 'POST') {
        const change = await body(request);
        if (change?.clearLog === true) clearLog();
        writeSettings({ noAi: change?.noAi, kinds: change?.kinds && typeof change.kinds === 'object' ? change.kinds : {} });
      }
      json(response, 200, { config: describeConfig(ai), ...privacyState(ai), log: readLog({ limit: 100 }) });
      return;
    }
    // A question about a step: first the exact request (preview), then the
    // question is sent only with the same fingerprint.
    if ((url.pathname === '/api/pergunta' || url.pathname === '/api/pergunta/preview') && request.method === 'POST') {
      const asked = await body(request);
      const dossier = requestWithDigest(String(asked.requestId ?? ''));
      if (!dossier) { json(response, 404, { error: t('panel.api.requestNotFound') }); return; }
      const question = { config: ai, dossier, stepId: String(asked.stepId ?? ''), question: String(asked.question ?? ''), readCode: source };
      if (url.pathname.endsWith('/preview')) {
        if (!ai.provider) { json(response, 200, { available: false, text: t('ai.question.noModel') }); return; }
        const reason = blocked('questions', ai);
        if (reason) { json(response, 200, { available: false, blocked: reason, text: blockedText(reason) }); return; }
        const preview = questionRequest(question);
        json(response, 200, preview ? { available: true, system: preview.system, text: preview.text, hash: preview.hash, model: ai.model, provider: ai.provider,
          local: Boolean(ai.local), valuesSent: preview.valuesSent, valuesWithheld: preview.valuesWithheld } : { available: true, known: false, text: t('ai.question.notFound') });
        return;
      }
      if (typeof asked.hash !== 'string') { json(response, 409, { error: t('panel.api.lookFirst') }); return; }
      json(response, 200, await answerQuestion({ ...question, hash: asked.hash }));
      return;
    }
    // Purpose sentences of the AI model: generated in the background, the
    // panel asks again until they are all there.
    const wanted = url.pathname.match(/^\/api\/(actions|requests)\/(.+)\/finalidades$/);
    if (wanted) {
      if (!purposes) { json(response, 200, { finished: true, purposes: {}, done: 0, total: 0, errors: [] }); return; }
      const id = decodeURIComponent(wanted[2]);
      json(response, 200, purposes.status(`${wanted[1]}:${id}`, async () => {
        if (wanted[1] === 'requests') return { dossiers: [requestWithDigest(id)].filter(Boolean) };
        const action = await actionWithDigest(id);
        if (!action) return { dossiers: [] };
        if (action.pending) throw new Error(t('panel.api.actionPending'));
        return { action, dossiers: action.timeline.flatMap(item => item.server ?? []) };
      }));
      return;
    }
    const action = url.pathname.match(/^\/api\/actions\/(.+)$/);
    if (action) {
      const dossier = await actionWithDigest(decodeURIComponent(action[1]));
      json(response, dossier ? 200 : 404, dossier ?? { error: t('panel.api.actionNotFound') });
      return;
    }
    const match = url.pathname.match(/^\/api\/requests\/(.+)$/);
    if (match) {
      const dossier = requestWithDigest(decodeURIComponent(match[1]));
      json(response, dossier ? 200 : 404, dossier ?? { error: t('panel.api.requestNotFound') });
      return;
    }
    if (url.pathname === '/api/source') {
      const result = source(url.searchParams.get('run'), url.searchParams.get('file'),
        Number(url.searchParams.get('line')), Number(url.searchParams.get('end')) || null);
      json(response, result ? 200 : 404, result ?? { error: t('panel.api.noCode') });
      return;
    }
    json(response, 404, { error: t('panel.api.notFound') });
  } catch (error) {
    json(response, 500, { error: String(error.message) });
  }
});
server.listen(port, '127.0.0.1', () => console.log(t('panel.api.listening', { url: `http://127.0.0.1:${port}` })));

// Text put into the page's markup.
const html = value => String(value).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html(t('panel.page.title'))}</title>
<style>
:root { --bg:#f7f7f5; --panel:#fff; --text:#1d1d1b; --muted:#6b6b66; --line:#e4e3de; --accent:#2f5bd3;
  --db:#0f7b5f; --http:#6a4bc4; --ia:#b4531f; --mail:#1f73b4; --pay:#9b2c86; --file:#7a6a12; --auth:#3d6b2f; --error:#c0392b; --code:#f1f0ec;
  --browser:#0b6e99; --server:#5b4bb4; }
@media (prefers-color-scheme: dark) { :root { --bg:#161615; --panel:#1f1f1d; --text:#ecebe6; --muted:#9a9993; --line:#33332f; --accent:#7ea2ff;
  --db:#43c49f; --http:#a78bfa; --ia:#f59e6b; --mail:#6cb4ee; --pay:#e27dcc; --file:#d9c65a; --auth:#8bc77a; --error:#ff7b6b; --code:#262624;
  --browser:#5cc2ec; --server:#a99bf5; } }
* { box-sizing:border-box; }
body { margin:0; font:14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); }
header { padding:10px 20px; border-bottom:1px solid var(--line); display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
header h1 { font-size:16px; margin:0; }
header .tabs { display:flex; gap:4px; }
header .tabs button { font:inherit; font-size:13px; color:var(--muted); background:none; border:1px solid transparent; border-radius:6px; padding:3px 10px; cursor:pointer; }
header .tabs button.on { color:var(--text); border-color:var(--line); background:var(--panel); }
header .runs { margin-left:auto; color:var(--muted); font-size:12.5px; }
header select { font:inherit; color:var(--text); background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:3px 6px; max-width:320px; }
main { display:grid; grid-template-columns:minmax(280px, 380px) 1fr; height:calc(100vh - 49px); }
body.embed header, body.embed #list { display:none; }
body.embed main { grid-template-columns:1fr; height:100vh; }
body.embed #detail { padding:12px 16px 30px; }
#list { overflow:auto; border-right:1px solid var(--line); background:var(--panel); }
#list button { all:unset; display:block; width:100%; padding:9px 14px; border-bottom:1px solid var(--line); cursor:pointer; }
#list button:hover, #list button.active { background:var(--code); }
.req-line { display:flex; gap:8px; align-items:baseline; }
.method { font-weight:600; font-size:12px; min-width:44px; }
.path { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:ui-monospace, Menlo, monospace; font-size:13px; }
.label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13.5px; font-weight:500; }
.meta { color:var(--muted); font-size:12px; margin-top:2px; }
.status-ok { color:var(--db); } .status-bad { color:var(--error); }
#detail { overflow:auto; padding:18px 24px 40px; }
.empty { color:var(--muted); padding:40px 0; }
h2 { font-size:17px; margin:0 0 4px; }
h2.mono { font-family:ui-monospace, Menlo, monospace; }
.note { color:var(--muted); font-size:12.5px; margin:0 0 16px; }
.minimal { border:1px solid #d9a200; background:rgba(217,162,0,.10); border-radius:6px; padding:8px 10px; font-size:13px; margin:0 0 12px; }
.step { display:grid; padding:2px 6px; border-radius:6px; align-items:baseline; }
.step.fn, .step.src { cursor:pointer; } .step.fn:hover, .step.src:hover { background:var(--code); }
.step .name { font-family:ui-monospace, Menlo, monospace; font-size:13px; }
.step .where { color:var(--muted); font-size:12px; margin-left:8px; font-family:ui-monospace, Menlo, monospace; }
.step .time { color:var(--muted); font-size:12px; font-variant-numeric:tabular-nums; white-space:nowrap; }
.step.error .name { color:var(--error); }
.tag { display:inline-block; font-size:11px; font-weight:600; padding:0 6px; border-radius:4px; margin-right:6px; border:1px solid currentColor; }
.k-base-de-dados { color:var(--db); } .k-http { color:var(--http); } .k-ia { color:var(--ia); } .k-email, .k-mensagem { color:var(--mail); }
.k-pagamento { color:var(--pay); } .k-ficheiros { color:var(--file); } .k-autenticação { color:var(--auth); }
.k-browser { color:var(--browser); } .k-servidor { color:var(--server); }
.boundary .name, .plain .name { font-family:system-ui, sans-serif; }
.boundary .detail, .plain .detail { color:var(--muted); font-size:12px; font-family:ui-monospace, Menlo, monospace; display:block; margin-left:0; white-space:pre-wrap; word-break:break-word; }
.cross { margin:6px 0 2px; padding:4px 8px; border-left:3px solid var(--server); background:var(--panel); border-radius:0 6px 6px 0; font-size:13px; }
.cross.browser { border-left-color:var(--browser); }
.cross .name { font-family:ui-monospace, Menlo, monospace; }
.server-part { margin:2px 0 8px 14px; padding-left:8px; border-left:1px dashed var(--line); }
section.box { margin-top:22px; padding:12px 14px; background:var(--panel); border:1px solid var(--line); border-radius:8px; }
section.box h3 { margin:0 0 6px; font-size:13px; }
section.box ul { margin:0; padding-left:18px; }
pre.code { background:var(--code); padding:10px 0; border-radius:8px; overflow:auto; font:12.5px/1.5 ui-monospace, Menlo, monospace; margin:8px 0 0; }
pre.code span.n { display:inline-block; width:48px; text-align:right; padding-right:12px; color:var(--muted); user-select:none; }
#code { position:sticky; bottom:0; }
.step { grid-template-columns:18px 1fr auto; gap:6px; }
.step.plain { grid-template-columns:1fr auto; }
.step .body { min-width:0; }
.step .sent { font-size:13.5px; }
.step .where { margin-left:8px; }
.caret { all:unset; width:18px; text-align:center; color:var(--muted); cursor:pointer; font-size:11px; }
.node.closed > .kids { display:none; }
#detail:not(.full) .step.internal, #detail:not(.full) .detail.sql { display:none; }
.step.grp .sent { color:var(--muted); }
.step.warn .sent::after { content:''; }
.k-grupo { color:var(--muted); }
.src-ia { display:inline-block; font-size:10.5px; font-weight:600; color:var(--accent); border:1px solid currentColor; border-radius:4px; padding:0 4px; margin-left:6px; vertical-align:1px; }
.src-rej { color:var(--muted); }
.summary { font-size:14.5px; margin:2px 0 4px; }
#ai { color:var(--muted); font-size:12px; margin:0 0 6px; }
header a.privacy { margin-left:12px; color:var(--accent); font-size:13px; }
.toolbar { display:flex; gap:8px; margin:0 0 8px; }
.acts { display:none; margin-left:8px; }
.step:hover .acts { display:inline; }
.mini { font:inherit; font-size:11px; color:var(--accent); background:none; border:1px solid var(--line); border-radius:5px; padding:0 5px; margin-left:4px; cursor:pointer; text-decoration:none; }
.mini.on { color:var(--db); border-color:currentColor; }
.acts:has(.mini.on) { display:inline; }
.values { font:12px/1.4 ui-monospace, Menlo, monospace; color:var(--muted); margin:0 0 3px; word-break:break-word; }
.k-detalhe { color:var(--db); }
.detail-state { font-size:12.5px; margin:0 0 8px; }
pre.code span.ran { background:color-mix(in srgb, var(--db) 18%, transparent); display:inline-block; width:100%; }
pre.code span.idle { opacity:.45; }
.ask { display:flex; gap:6px; margin-top:10px; }
.ask input { flex:1; font:inherit; padding:5px 8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--text); }
.ask button, .box .toolbar button { font:inherit; font-size:12.5px; padding:4px 10px; border:1px solid var(--line); border-radius:6px; background:var(--panel); color:var(--text); cursor:pointer; }
.answer { margin-top:8px; padding:8px 10px; border-left:3px solid var(--accent); background:var(--bg); border-radius:0 6px 6px 0; font-size:13.5px; }
.answer.unknown { border-left-color:var(--muted); }
.answer.rejected { border-left-color:var(--error); }
.toolbar button { font:inherit; font-size:12px; color:var(--muted); background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:2px 8px; cursor:pointer; }
@media (max-width: 760px) { main { grid-template-columns:1fr; height:auto; } #list { max-height:40vh; } }
</style>
</head>
<body>
<header><h1>CodeTAC</h1><div class="tabs"><button data-tab="actions" class="on">${html(t('panel.page.actions'))}</button><button data-tab="requests">${html(t('panel.page.requestsWithoutAction'))}</button></div>
<label class="runs">${html(t('panel.page.recording'))} <select id="run"></select></label> <a class="privacy" href="/privacy" title="${html(t('panel.page.privacyTitle'))}">${html(t('panel.page.privacy'))}</a></header>
<main>
  <nav id="list"><p class="empty" style="padding:14px">${html(t('panel.page.loading'))}</p></nav>
  <article id="detail"><p class="empty">${html(t('panel.page.choose'))}</p></article>
</main>
<script>
const params = new URLSearchParams(location.search);
const embed = params.get('embed') === '1';
if (embed) document.body.classList.add('embed');
const list = document.getElementById('list');
const detail = document.getElementById('detail');
let tab = 'actions';
let selected = params.get('action') ? { type: 'action', id: params.get('action') } : params.get('request') ? { type: 'request', id: params.get('request') } : null;
const esc = value => String(value ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
const ms = value => value == null ? '' : value < 1 ? value.toFixed(2) + ' ms' : value < 1000 ? value.toFixed(1) + ' ms' : (value / 1000).toFixed(2) + ' s';
const time = at => at ? new Date(at).toLocaleTimeString('en-GB') : '';
// Recorded values (kinds, operations, modes) are kept in Portuguese: shown in English.
const LABELS = ${JSON.stringify(LABELS)};
const label = value => LABELS[value] ?? value;
const kindLabel = kind => kind === 'http' ? 'HTTP' : label(kind);
// The sentences, from src/structure/text/<language>.json (panel.page): t('key', { hole: value }).
const TEXT = ${JSON.stringify(TEXT.panel.page).replace(/</g, '\\u003c')};
const t = (key, vars = {}) => {
  let value = key.split('.').reduce((node, part) => node?.[part], TEXT);
  if (value && typeof value === 'object' && 'other' in value) value = vars.count === 1 ? value.one : value.other;
  if (typeof value !== 'string') return key;
  return value.replace(/\\{(\\w+)\\}/g, (hole, name) => (name in vars ? String(vars[name]) : hole));
};

const runSelect = document.getElementById('run');
async function loadRuns() {
  const runs = await (await fetch('/api/runs')).json();
  const current = runSelect.value;
  runSelect.innerHTML = runs.map(r => '<option value="' + esc(r.run) + '">' + esc(r.run) + ' (' + (r.actions ? t('runActions', { count: r.actions }) + ', ' : '') + t('runRequests', { count: r.requests }) + ')</option>').join('');
  if (current && runs.some(r => r.run === current)) runSelect.value = current;
}
runSelect.addEventListener('change', () => { selected = null; loadList(); });
document.querySelector('.tabs').addEventListener('click', event => {
  const button = event.target.closest('button[data-tab]');
  if (!button) return;
  tab = button.dataset.tab;
  for (const item of document.querySelectorAll('.tabs button')) item.classList.toggle('on', item === button);
  loadList();
});
async function loadList() {
  const run = encodeURIComponent(runSelect.value);
  if (tab === 'actions') {
    const actions = await (await fetch('/api/actions?run=' + run)).json();
    if (!actions.length) { list.innerHTML = '<p class="empty" style="padding:14px">' + t('noActions') + '</p>'; return; }
    list.innerHTML = actions.map(a => '<button data-type="action" data-id="' + esc(a.actionId) + '"' + (selected && selected.id === a.actionId ? ' class="active"' : '') + '>' +
      '<div class="label">' + esc(a.label) + '</div>' +
      '<div class="meta">' + esc(a.page || '') + ' · ' + t('serverRequests', { count: a.serverRequests }) +
      (a.pending ? ' · ' + t('inProgress') : '') + ' · ' + time(a.at) + '</div></button>').join('');
    return;
  }
  const requests = await (await fetch('/api/requests?semAcao=1&run=' + run)).json();
  if (!requests.length) { list.innerHTML = '<p class="empty" style="padding:14px">' + t('noRequests') + '</p>'; return; }
  list.innerHTML = requests.map(r => '<button data-type="request" data-id="' + esc(r.requestId) + '"' + (selected && selected.id === r.requestId ? ' class="active"' : '') + '>' +
    '<div class="req-line"><span class="method">' + esc(r.method) + '</span><span class="path">' + esc(r.path) + '</span></div>' +
    '<div class="meta"><span class="' + (r.status >= 400 ? 'status-bad' : 'status-ok') + '">' + esc(r.status ?? '…') + '</span> · ' + ms(r.durationMs) +
    ' · ' + t('functionsCount', { count: r.functions ?? 0 }) + ' · ' + t('boundariesCount', { count: r.boundaries ?? 0 }) + ' · ' + time(r.at) + '</div></button>').join('');
}
list.addEventListener('click', event => {
  const button = event.target.closest('button[data-id]');
  if (!button) return;
  selected = { type: button.dataset.type, id: button.dataset.id };
  show();
  loadList();
});
function show() {
  if (!selected) return;
  return selected.type === 'action' ? loadAction(selected.id) : loadDossier(selected.id);
}

function relative(root, file) { return root && file && file.startsWith(root + '/') ? file.slice(root.length + 1) : file; }
// Grouped view: one row per step with its purpose sentence; groups and
// functions with steps inside open with the arrow.
// Rows keep what the step box needs (code, values, questions) by id.
const stepData = new Map();
// Work done after the response was sent (FastAPI BackgroundTasks, teardown).
function afterTag(n) {
  return n.afterResponse ? ' <span class="tag" title="' + t('afterTitle') + '">' + t('after') + '</span>' : '';
}
function editorLink(file, line) {
  if (!aiConfig || !aiConfig.editor || !file || file[0] !== '/') return '';
  return '<a class="mini" href="' + esc(aiConfig.editor + '://file' + encodeURI(file) + ':' + (line || 1) + ':1') + '" title="' + t('openInEditorTitle', { line: esc(line) }) + '">' + t('openInEditor') + '</a>';
}
function asked(c, n) {
  const spec = detailSpecs[c.run];
  if (!spec) return false;
  return spec.files.includes(n.file) || spec.functions.some(f => f.file === n.file && f.line === n.line && (f.function || '') === (n.function || ''));
}
function short(value) {
  const text = JSON.stringify(value);
  return text === undefined ? '' : text.length > 160 ? text.slice(0, 160) + '…' : text;
}
function valuesHtml(n, pad) {
  const d = n.detail;
  const args = d.args.map(a => esc(a.name) + ' = ' + esc(short(a.value))).join(', ');
  const out = 'returned' in d ? t('returned', { value: esc(short(d.returned)) }) : '<span style="color:var(--error)">' + t('threw', { value: esc(short(d.threw)) }) + '</span>';
  return '<div class="values" ' + pad + '><span class="tag k-detalhe">' + t('values') + '</span>' + (args ? t('input', { args }) + ' · ' : t('noArguments') + ' · ') + out +
    ' · ' + t('linesRun', { count: d.lines.length }) + '</div>';
}
function rowHtml(n, c, depth, open) {
  const pad = 'style="padding-left:' + (4 + depth * 18) + 'px"';
  const valuesPad = 'style="padding-left:' + (28 + depth * 18) + 'px"';
  const inner = n.type === 'group' ? n.children : (n.children || []);
  const caret = inner.length ? '<button class="caret" aria-label="' + t('openOrClose') + '">' + (open ? '▾' : '▸') + '</button>' : '<span class="caret"></span>';
  let row;
  if (n.type !== 'group') stepData.set(n.id, { node: n, c });
  if (n.type === 'group') {
    row = '<div class="step grp' + (n.errors ? ' warn' : '') + '" ' + pad + '>' + caret + '<span class="body"><span class="tag k-grupo">' + t('steps', { count: n.count }) + '</span><span class="sent">' + esc(n.sentence) + '</span></span><span class="time">' + ms(n.durationMs) + '</span></div>';
  } else if (n.type === 'function') {
    // Without a line (a template whose lines could not be mapped): the file only.
    const where = n.file ? relative(c.root, n.file) + (n.line != null ? ':' + n.line : ' (' + t('noLines') + ')') : '';
    // A function with nothing inside is named in its parent's sentence ("calls …"):
    // the grouped view leaves it out; "Show all" shows it in place.
    const internal = depth > 0 && !inner.length && !n.error && !n.detail;
    const on = asked(c, n);
    row = '<div class="step fn' + (n.error ? ' error' : '') + (internal ? ' internal' : '') + '" ' + pad + ' data-step="' + esc(n.id) + '">' + caret +
      '<span class="body"><span class="sent" data-node="' + esc(n.id) + '" data-facts="' + esc(n.purpose.text) + '">' + esc(n.purpose.text) + '</span>' +
      '<span class="where" title="' + esc(where) + '">' + esc(n.function) + (where ? ' · ' + esc(where.split('/').pop()) : '') + '</span>' + (n.error ? ' <span class="tag" style="color:var(--error)">' + t('error') + '</span>' : '') +
      (n.opaque ? ' <span class="tag" title="' + t('opaqueTitle') + '">' + t('opaque') + '</span>' : '') + afterTag(n) +
      (n.opaque ? '' : '<span class="acts"><button class="mini' + (on ? ' on' : '') + '" data-detalhe="' + esc(n.id) + '" title="' + t(on ? 'detailOnTitle' : 'detailRequestTitle') + '">' + t(on ? 'detailOn' : 'requestDetail') + '</button>' +
      editorLink(n.file, n.line) + planLink(n, c) + '</span>') + '</span><span class="time">' + ms(n.durationMs) + '</span></div>' + (n.detail ? valuesHtml(n, valuesPad) : '');
  } else {
    const r = n.result || {};
    row = '<div class="step boundary' + (n.error || r.error ? ' error' : '') + '" ' + pad + ' data-step="' + esc(n.id) + '">' + caret + '<span class="body"><span class="tag k-' + esc(n.kind) + '">' + esc(kindLabel(n.kind)) + '</span>' + afterTag(n) +
      '<span class="sent" data-node="' + esc(n.id) + '" data-facts="' + esc(n.purpose.text) + '">' + esc(n.purpose.text) + '</span>' +
      (n.sql ? '<span class="detail sql">' + esc(n.sql) + '</span>' : '') +
      (r.promptExcerpt || n.promptExcerpt ? '<span class="detail">' + t('prompt', { text: esc(r.promptExcerpt || n.promptExcerpt) }) + '</span>' : '') +
      (r.answerExcerpt ? '<span class="detail">' + t('answer', { text: esc(r.answerExcerpt) }) + '</span>' : '') +
      '</span><span class="time">' + ms(n.durationMs) + '</span></div>';
  }
  if (!inner.length) return row;
  return '<div class="node' + (open ? '' : ' closed') + '" data-start="' + (open ? 'open' : 'closed') + '">' + row + '<div class="kids">' + nodesHtml(inner, c, depth + 1, n.type === 'group' ? false : null) + '</div></div>';
}
// A step starts open when there is a boundary, an error or recorded values
// inside it, so the way to them is visible; groups start closed.
function busy(n) { return (n.children || []).some(c => c.type === 'boundary' || c.error || c.detail || busy(c)); }
// The step on the Structure plan: the whole action lit, this function in focus.
function planLink(n, c) {
  if (!c.run || !n.file || n.line == null || !c.root) return '';
  const rel = relative(c.root, n.file);
  if (rel === n.file) return '';
  const target = selected && selected.type === 'action' ? 'action=' + encodeURIComponent(selected.id) : 'request=' + encodeURIComponent(c.req);
  const url = '/structure?' + (embed ? 'embed=1&' : '') + 'run=' + encodeURIComponent(c.run) + '&' + target + '&focus=' + encodeURIComponent(rel + '#' + n.function + '@' + n.line);
  return ' <a class="mini" href="' + esc(url) + '" title="' + t('seeOnPlanTitle') + '">' + t('seeOnPlan') + '</a>';
}
function nodesHtml(nodes, c, depth, forced) {
  return nodes.map(n => rowHtml(n, c, depth, forced === false ? false : n.type === 'group' ? false : busy(n))).join('');
}
function digestHtml(d) {
  return nodesHtml(d.digest.nodes, { run: d.request.run, root: d.root, req: d.request.requestId }, 0, null);
}
// Detail requested in each recording (detalhe.json, read by the running app).
const detailSpecs = {};
async function loadDetail(run) {
  if (!run) return;
  try { detailSpecs[run] = await (await fetch('/api/detalhe?run=' + encodeURIComponent(run))).json(); } catch {}
  if (!detailSpecs[run] || detailSpecs[run].error) detailSpecs[run] = { functions: [], files: [] };
}
function detailStateHtml(run) {
  const spec = detailSpecs[run];
  if (!spec || (!spec.functions.length && !spec.files.length)) return '';
  const items = spec.functions.map(f => esc(f.function || '?') + ' <span class="where">' + esc(String(f.file).split('/').pop()) + ':' + f.line + '</span>')
    .concat(spec.files.map(f => t('wholeFile') + ' <span class="where">' + esc(String(f).split('/').pop()) + '</span>'));
  return '<p class="detail-state"><span class="tag k-detalhe">' + t('detailOn') + '</span>' + items.join(', ') +
    ' — ' + t('appliesNext') + ' <button class="mini" data-limpar="' + esc(run) + '">' + t('turnAllOff') + '</button></p>';
}
async function changeDetail(change) {
  const response = await fetch('/api/detalhe', { method: 'POST', headers: { 'content-type': 'application/json', 'x-codetac': '1' }, body: JSON.stringify(change) });
  const spec = await response.json();
  if (!spec.error) detailSpecs[change.run] = spec;
  const open = document.getElementById('pergunta')?.dataset.step;
  await show();
  if (open && stepData.has(open)) openStep(open);
}
function effectsHtml(e) {
  const lasting = e.items.filter(i => !['sem-alteracao', 'leitura-externa', 'custo'].includes(i.category));
  const other = e.items.filter(i => ['sem-alteracao', 'leitura-externa', 'custo'].includes(i.category));
  return '<section class="box effects"><h3>' + t('lastingEffects') + '</h3>' +
    (lasting.length ? '<ul>' + lasting.map(i => '<li>' + esc(i.text) + '</li>').join('') + '</ul>' : '<p class="note" style="margin:0">' + esc(e.none) + '</p>') +
    (other.length ? '<h3 style="margin-top:8px">' + t('noLastingEffect') + '</h3><ul class="meta">' + other.map(i => '<li>' + esc(i.text) + '</li>').join('') + '</ul>' : '') +
    '<p class="note" style="margin:6px 0 0">' + esc(e.unseen) + '</p></section>';
}
// Phase 5: the diagnostic codes, in plain words.
const REASONS = TEXT.reasons;
function minimalHtml(d) {
  if (d.level !== 'minimo') return '';
  return '<p class="minimal"><b>' + t('minimalTitle') + '</b> ' + t('minimalBody', { reason: d.reason ? ' (' + esc(d.reason) + ')' : '', command: '<code>codetac diagnose</code>' }) + '</p>';
}
function limitsHtml(limitations, extra) {
  const items = limitations.map(l => '<li>' + esc(REASONS[l.reason] || l.reason) + ' (' + l.count + ')</li>').concat(extra || []);
  if (!items.length) return '';
  return '<section class="box"><h3>' + t('cannotSee') + '</h3><ul>' + items.join('') +
    '</ul><p class="note" style="margin:6px 0 0">' + t('cannotSeeNote') + '</p></section>';
}

async function loadDossier(id) {
  const d = await (await fetch('/api/requests/' + encodeURIComponent(id))).json();
  if (d.error) { detail.innerHTML = '<p class="empty">' + esc(d.error) + '</p>'; return; }
  if (!aiConfig) aiConfig = await (await fetch('/api/config')).json();
  await loadDetail(d.request.run);
  const q = d.request.queryKeys.length ? '?' + d.request.queryKeys.map(k => esc(k) + '=…').join('&') : '';
  let html = '<h2 class="mono">' + esc(d.request.method) + ' ' + esc(d.request.path) + q + '</h2>' +
    '<p class="note">' + t('status', { status: esc(d.request.status ?? t('inProgress')) }) + ' · ' + ms(d.request.durationMs) + ' · ' + time(d.request.at) +
    ' · ' + t('levelLine', { level: esc(label(d.level)), what: t(d.level === 'minimo' ? 'levelMinimal' : 'levelFull') }) + '</p>';
  html += minimalHtml(d) + '<p id="ai"></p>' + TOOLBAR + detailStateHtml(d.request.run);
  if (!d.steps.length) html += '<p class="empty">' + t('noSteps') + '</p>';
  else if (d.level !== 'minimo' && !d.steps.some(s => s.type === 'function')) html += '<p class="note">' + t('onlyBoundaries', { command: '<code>codetac diagnose</code>' }) + '</p>';
  html += digestHtml(d) + effectsHtml(d.digest.effects) + limitsHtml(d.limitations) + '<div id="code"></div>';
  detail.innerHTML = html;
  startPurposes('requests', id);
}

// AI purpose sentences, when a model is configured: they replace the fixed
// sentence as they arrive; the fixed one stays as the facts beside it.
const TOOLBAR = '<div class="toolbar"><button data-all="open">' + t('showAll') + '</button><button data-all="close">' + t('grouped') + '</button></div>';
let aiConfig = null;
let purposeTimer = null;
const known = {};
async function startPurposes(kind, id) {
  clearTimeout(purposeTimer);
  if (!aiConfig) aiConfig = await (await fetch('/api/config')).json();
  const box = document.getElementById('ai');
  if (!box) return;
  if (!aiConfig.active) {
    box.textContent = t('fixed') + (aiConfig.problem ? ' (' + aiConfig.problem + ')' : ' (' + t('noModel') + ').');
    return;
  }
  const r = await (await fetch('/api/' + kind + '/' + encodeURIComponent(id) + '/finalidades')).json();
  if (r.blocked) { box.textContent = t('fixed') + '. ' + r.blockedText; return; }
  known[id] = r.purposes;
  applyPurposes(r.purposes);
  const who = aiConfig.model + ' (' + (aiConfig.local ? t('localModel') : t('remoteModel', { provider: aiConfig.provider })) + ')';
  const rejected = Object.values(r.purposes).filter(p => p.rejected).length;
  box.textContent = r.finished
    ? t('writtenBy', { who }) + (rejected ? '; ' + t('rejectedKept', { count: rejected }) : '') + '.' + (r.errors.length ? ' ' + t('failures', { list: r.errors.join('; ') }) : '')
    : t('writing', { who, done: r.done }) + (r.total != null ? ' ' + t('of', { total: r.total }) : '');
  if (!r.finished && selected && selected.id === id) purposeTimer = setTimeout(() => startPurposes(kind, id), 1200);
}
function applyPurposes(map) {
  for (const el of detail.querySelectorAll('[data-node]')) {
    const p = map && map[el.dataset.node];
    if (!p || el.dataset.applied) continue;
    el.dataset.applied = '1';
    if (p.source === 'ia') {
      const boundary = el.closest('.boundary');
      el.innerHTML = esc(p.text) + '<span class="src-ia" title="' + t('aiTitle') + '">' + t('ai') + '</span>' +
        (boundary ? ' <span class="where">' + esc(el.dataset.facts) + '</span>' : '');
      el.title = t('recordedFacts', { facts: el.dataset.facts });
    } else if (p.rejected) {
      el.insertAdjacentHTML('beforeend', '<span class="src-ia src-rej" title="' + esc(t('aiRejectedTitle', { reason: p.rejected, proposed: p.proposed })) + '">' + t('aiRejected') + '</span>');
    }
  }
}

function srcAttrs(run, origin, before) {
  if (!origin || !origin.project) return '';
  return ' data-run="' + esc(run) + '" data-file="' + esc(origin.file) + '" data-line="' + Math.max(1, origin.line - (before || 0)) + '"';
}
function whereHtml(origin) {
  if (!origin) return '';
  if (origin.project) return '<span class="where">' + esc(origin.short) + ':' + esc(origin.line ?? '?') + '</span> ' + editorLink(origin.file, origin.line);
  return origin.library ? '<span class="where">(' + esc(origin.library) + ')</span>' : '';
}
function componentsHtml(list, verb) {
  const own = (list || []).filter(c => c.origin && c.origin.project);
  const other = (list || []).length - own.length;
  if (!own.length && !other) return '';
  return '<li>' + verb + ': ' + (own.length ? own.map(c => '<b>' + esc(c.name) + '</b>' + (c.count > 1 ? ' (' + c.count + '×)' : '') +
    ' <span class="where">' + esc(c.origin.short) + ':' + c.origin.line + '</span>').join(', ') : '') +
    (other ? (own.length ? ' · ' : '') + '<span class="where">' + t('fromFramework', { count: other }) + '</span>' : '') + '</li>';
}
let actionTimer = null;
async function loadAction(id) {
  clearTimeout(actionTimer);
  const response = await fetch('/api/actions/' + encodeURIComponent(id));
  const d = await response.json();
  if (d.error) {
    detail.innerHTML = '<p class="empty">' + esc(d.error) + ' ' + t('tryingAgain') + '</p>';
    actionTimer = setTimeout(() => loadAction(id), 1500);
    return;
  }
  const run = d.run;
  if (!aiConfig) aiConfig = await (await fetch('/api/config')).json();
  await loadDetail(run);
  let html = '<h2>' + esc(d.label) + '</h2><p class="summary" data-node="action" data-facts="' + esc(d.digest.summary) + '">' + esc(d.digest.summary) + '</p><p class="note">' + time(d.startedAt) + (d.durationMs ? ' · ' + t('actionOf', { duration: ms(d.durationMs) }) : '') +
    ' · ' + t('actionNote', { level: esc(label(d.level)) }) + '</p>';
  html += minimalHtml(d) + '<p id="ai"></p>' + TOOLBAR + detailStateHtml(run);
  const explained = new Set();  // origin notes already explained in full in this action
  for (const item of d.digest.timeline) {
    if (item.type === 'dev-group') {
      html += '<div class="node closed"><div class="step grp"><button class="caret">▸</button><span class="body"><span class="tag k-grupo">' + item.items.length + '</span><span class="sent">' + esc(item.sentence) + '</span></span><span class="time"></span></div>' +
        '<div class="kids">' + item.items.map(i => '<div class="step plain" style="padding-left:28px"><span class="body"><span class="where">' + esc(i.browser.method) + ' ' + esc(i.browser.path) + '</span></span><span class="time">' + ms(i.browser.durationMs) + '</span></div>').join('') + '</div></div>';
    } else if (item.type === 'trigger') {
      const trigger = item.trigger;
      const c = trigger.component || {};
      const place = c.origin && c.origin.project ? c.origin : c.project ? c.project.origin : c.origin;
      const via = c.project ? ' · ' + esc(c.project.via) + ' (' + t('library') + ')' + (c.project.name ? ' ' + t('usedIn', { name: esc(c.project.name) }) : '') : '';
      const verb = trigger.event === 'submit' ? 'submitOf' : trigger.event === 'change' ? 'changeIn' : 'clickOn';
      html += '<div class="step plain src" style="padding-left:6px"' + srcAttrs(run, place, 3) + '><span><span class="tag k-browser">' + t('browser') + '</span><span class="name">' +
        t(verb, { label: esc(d.label) }) + '</span> ' + whereHtml(place) +
        '<span class="detail">' + t('page', { path: esc(item.page && item.page.path) }) + (c.name ? ' · ' + t('component', { name: esc(c.name) }) : '') + via + '</span></span><span class="time"></span></div>';
      const handlers = [trigger.handler, trigger.submit && trigger.submit.handler].filter(Boolean);
      for (const h of handlers) {
        html += '<div class="step plain" style="padding-left:24px"><span><span class="name">' + t('handler', { name: '<b>' + esc(h.name) + '</b>' }) + '</span>' +
          '<span class="where">' + esc(h.prop || (h.source === 'dom' ? 'addEventListener' : '')) + '</span></span><span class="time"></span></div>';
      }
      if (!handlers.length) html += '<div class="step plain" style="padding-left:24px"><span class="detail">' + t('noHandler') + '</span></div>';
    } else if (item.type === 'request') {
      const b = item.browser;
      const chainHtml = (b.chain || []).map(f => '<span class="step src" style="display:inline;padding:0 2px"' + srcAttrs(run, { project: true, file: f.file, line: f.line }, 3) + '>' +
        '<span class="name">' + esc(f.fn) + '</span> <span class="where">' + esc(f.short) + ':' + esc(f.line ?? '?') + '</span></span>').join(' → ');
      const via = b.libraries && b.libraries.length ? ' <span class="where">' + t('via', { list: b.libraries.map(esc).join(', ') }) + '</span>' : '';
      html += '<div class="cross browser"><span class="tag k-browser">' + t('browserTo', { target: b.sameOrigin ? t('server') : esc(b.host) }) + '</span><span class="name">' +
        esc(b.method) + ' ' + esc(b.path) + (b.queryKeys && b.queryKeys.length ? '?' + b.queryKeys.map(k => esc(k) + '=…').join('&') : '') + '</span> ' +
        '<span class="where">' + (b.status != null ? t('statusLower', { status: b.status }) : t(b.error ? 'failed' : 'noResponse')) + ' · ' + ms(b.durationMs) + '</span>' +
        (chainHtml || via ? '<div class="meta">' + t('calledBy', { list: chainHtml || '<span class="where">(' + t('noPosition') + ')</span>' }) + via + '</div>' : '') + '</div>';
      const note = originNote(item, d.origin, explained.has(item.probable ? 'provavel' : 'sem'));
      if (note) explained.add(item.probable ? 'provavel' : 'sem');
      html += note + serverHtml(item.server, b.sameOrigin, b);
    } else if (item.type === 'navigation') {
      const text = item.kind === 'page exit' || item.kind === 'saída da página' ? t('left', { path: esc(item.path) }) : esc(label(item.kind)) + ' → ' + esc(item.path);
      html += '<div class="step plain"><span><span class="tag k-browser">' + t('navigation') + '</span><span class="name">' + text + '</span></span><span class="time"></span></div>';
    } else if (item.type === 'document') {
      html += '<div class="cross"><span class="tag k-browser">' + t('newPage') + '</span><span class="name">' + esc(item.page && item.page.path) + '</span></div>';
      html += serverHtml(item.server, true);
    } else if (item.type === 'screen') {
      const s = item.screen || {};
      const parts = [];
      if (s.added || s.removed) parts.push(t('elementsChanged', { added: s.added || 0, removed: s.removed || 0 }));
      if (s.text) parts.push(t('textsChanged', { count: s.text }));
      if (s.attributes) parts.push(t('attributesChanged', { count: s.attributes }));
      if (s.title) parts.push(t('titleChanged'));
      const lines = [componentsHtml(s.stateChanged, t('stateChangedIn')), componentsHtml(s.mounted, t('appeared')), componentsHtml(s.unmounted, t('disappeared'))].join('');
      html += '<div class="cross browser"><span class="tag k-browser">' + t('screen') + '</span><span class="name">' + (parts.length ? esc(parts.join(' · ')) : t('noVisibleChange')) + '</span>' +
        (lines ? '<ul class="meta" style="margin:4px 0 0;padding-left:18px">' + lines + '</ul>' : '') +
        '<div class="meta">' + t('actionClosed', { reason: esc(label(item.closedBy || '')) }) + '</div></div>';
    } else if (item.type === 'unmatched') {
      html += '<div class="cross"><span class="tag k-servidor">' + t('server') + '</span><span class="name">' + t('unmatched') + '</span></div>';
      html += serverHtml(item.server, true);
    }
  }
  html += effectsHtml(d.digest.effects);
  const extra = ['<li>' + t('browserNotFollowed') + '</li>', '<li>' + t('timerAttributed') + '</li>'];
  if (!d.browserSeen) extra.push('<li>' + t('browserSilent') + '</li>');
  html += limitsHtml(d.limitations, extra) + '<div id="code"></div>';
  const scroll = detail.scrollTop;
  detail.innerHTML = html;
  detail.scrollTop = scroll;
  if (d.pending || !d.browserSeen) {
    applyPurposes(known[id]);
    actionTimer = setTimeout(() => loadAction(id), 1500);
  } else startPurposes('actions', id);
}
// DP3: a request of the page to another origin of the same machine (the API
// on another port, without a proxy), in plain language.
// The full explanation once per action; a short line for the next requests.
function originNote(item, pageOrigin, brief) {
  const b = item.browser;
  if (b.sameOrigin || !b.host) return '';
  let page = '';
  try { page = new URL(pageOrigin).hostname; } catch {}
  const name = b.host.replace(/:\\d+$/, '').replace(/^\\[|\\]$/g, '');
  const local = ['localhost', '127.0.0.1', '::1', page].includes(name);
  const proxy = ' ' + t('proxyTip', { option: '<code>server.proxy</code>' });
  if (item.probable && brief) return '<p class="note probable"><b>' + t('probableLink') + '</b> (' + t('asAbove') + ').</p>';
  if (!item.probable && local && brief) return '<p class="note probable"><b>' + t('noLink') + '</b> (' + t('asAbove') + ').</p>';
  if (item.probable) return '<p class="note probable"><b>' + t('probableLink') + '.</b> ' + t('probableBody', { host: esc(b.host) }) + proxy + '</p>';
  if (!local) return '';
  return '<p class="note probable"><b>' + t('noLink') + '.</b> ' + t('noLinkBody', { host: esc(b.host) }) + proxy + '</p>';
}

function serverHtml(list, sameOrigin, browser) {
  if (!list || !list.length) {
    return sameOrigin ? '<div class="server-part"><p class="note" style="margin:4px 0">' + t('notRecorded') + '</p></div>' : '';
  }
  const same = d => browser && list.length === 1 && browser.method === d.request.method && browser.path === d.request.path && browser.status === d.request.status;
  // A part with nothing inside (a CORS preflight, the hop of a proxy) takes one line.
  const empty = '<p class="note" style="margin:4px 0">' + t('noStepsHere') + '</p>';
  return list.map(d => '<div class="server-part">' + (same(d) ? (d.steps.length ? '' : empty) : '<div class="meta"><span class="tag k-servidor">' + t('server') + '</span>' + esc(d.request.method) + ' ' + esc(d.request.path) +
    ' · ' + t('statusLower', { status: esc(d.request.status ?? t('inProgress')) }) + ' · ' + ms(d.request.durationMs) + (d.steps.length ? '' : ' · ' + t('noStepsShort')) + '</div>') +
    (d.steps.length ? digestHtml(d) : '') + '</div>').join('');
}

detail.addEventListener('click', async event => {
  const caret = event.target.closest('.caret');
  if (caret && caret.tagName === 'BUTTON') {
    const node = caret.closest('.node');
    node.classList.toggle('closed');
    caret.textContent = node.classList.contains('closed') ? '▸' : '▾';
    return;
  }
  const all = event.target.closest('[data-all]');
  if (all) {
    const full = all.dataset.all === 'open';
    detail.classList.toggle('full', full);
    for (const node of detail.querySelectorAll('.node')) {
      const close = full ? false : node.dataset.start === 'closed';
      node.classList.toggle('closed', close);
      node.querySelector(':scope > .step > .caret').textContent = close ? '▸' : '▾';
    }
    return;
  }
  if (event.target.closest('a.mini')) return;
  const toggle = event.target.closest('[data-detalhe]');
  if (toggle) {
    const { node: n, c } = stepData.get(toggle.dataset.detalhe);
    await changeDetail({ run: c.run, op: 'funcao', file: n.file, line: n.line, function: n.function });
    return;
  }
  const whole = event.target.closest('[data-ficheiro]');
  if (whole) { await changeDetail({ run: whole.dataset.run, op: 'ficheiro', file: whole.dataset.ficheiro }); return; }
  const clear = event.target.closest('[data-limpar]');
  if (clear) { await changeDetail({ run: clear.dataset.limpar, op: 'limpar' }); return; }
  const ask = event.target.closest('[data-perguntar]');
  if (ask) { askQuestion(ask.dataset.perguntar); return; }
  if (event.target.closest('#code')) return;
  const row = event.target.closest('[data-step]');
  if (row) { openStep(row.dataset.step); return; }
  const place = event.target.closest('[data-file]');
  if (!place || !place.dataset.file) return;
  const params = new URLSearchParams({ run: place.dataset.run, file: place.dataset.file, line: place.dataset.line, end: place.dataset.end || '' });
  const result = await (await fetch('/api/source?' + params)).json();
  const box = document.getElementById('code');
  box.innerHTML = '<section class="box">' + (result.error ? '<p class="note" style="margin:0">' + esc(result.error) + '</p>'
    : '<h3>' + esc(result.file) + ':' + result.start + '–' + result.end + ' ' + editorLink(place.dataset.file, Number(place.dataset.line) + 3) + '</h3>' + codeHtml(result, null)) + '</section>';
  box.scrollIntoView({ block: 'nearest' });
});
detail.addEventListener('keydown', event => {
  if (event.key === 'Enter' && event.target.id === 'pergunta') { event.preventDefault(); askQuestion(event.target.dataset.step); }
});

// Code of a function; with recorded detail, the lines that ran are marked
// and the others inside the function are dimmed.
function codeHtml(result, lines) {
  const ran = lines ? new Set(lines) : null;
  return '<pre class="code">' + result.lines.map((text, i) => {
    const number = result.start + i;
    const cls = ran ? (ran.has(number) ? ' class="ran"' : ' class="idle"') : '';
    return '<span' + cls + '><span class="n">' + number + '</span>' + esc(text) + '</span>';
  }).join('\\n') + '</pre>';
}
// The box of one step: code (functions), values, detail and a question.
async function openStep(id) {
  const { node: n, c } = stepData.get(id);
  const box = document.getElementById('code');
  let html = '<section class="box">';
  if (n.type === 'function' && n.opaque) {
    // Nothing to show inside: no code, no values.
    html += '<h3>' + esc(n.function) + (n.file ? ' — ' + esc(relative(c.root, n.file)) : '') + '</h3>' +
      '<p class="note" style="margin:2px 0 6px">' + esc(n.purpose.text) + '. ' + t('opaqueNote') + '</p>';
  } else if (n.type === 'function') {
    const params = new URLSearchParams({ run: c.run, file: n.file, line: n.line, end: n.endLine ?? '' });
    const result = n.line == null ? { error: t('noLinesError') }
      : await (await fetch('/api/source?' + params)).json();
    const on = asked(c, n);
    const wholeFile = (detailSpecs[c.run] || { files: [] }).files.includes(n.file);
    html += '<h3>' + esc(n.function) + ' — ' + esc(result.file || relative(c.root, n.file)) + (n.line != null ? ':' + n.line : '') + ' ' + editorLink(n.file, n.line ?? 1) + '</h3>' +
      '<p class="note" style="margin:2px 0 6px">' + esc(n.purpose.text) + '</p>' +
      '<div class="toolbar"><button data-detalhe="' + esc(n.id) + '">' + t(on && !wholeFile ? 'detailFunctionOff' : 'detailFunctionOn') + '</button>' +
      '<button data-ficheiro="' + esc(n.file) + '" data-run="' + esc(c.run) + '">' + t(wholeFile ? 'detailFileOff' : 'detailFileOn') + '</button></div>';
    if (n.detail) {
      const d = n.detail;
      html += '<p class="note" style="margin:6px 0 2px">' + t('valuesRecorded') + '</p><pre class="code values-full">' +
        esc(JSON.stringify({ input: Object.fromEntries(d.args.map(a => [a.name, a.value])), ...('returned' in d ? { returned: d.returned } : { threw: d.threw }) }, null, 2)) + '</pre>' +
        '<p class="note" style="margin:6px 0 2px">' + t('greenLines') + '</p>';
    } else if (on) {
      html += '<p class="note" style="margin:6px 0 2px">' + t('detailRepeat') + '</p>';
    }
    html += result.error ? '<p class="note">' + esc(result.error) + '</p>' : codeHtml(result, n.detail ? n.detail.lines : null);
  } else {
    html += '<h3>' + esc(kindLabel(n.kind)) + ': ' + esc(n.purpose.text) + '</h3>' + (n.sql ? '<pre class="code">' + esc(n.sql) + '</pre>' : '');
  }
  html += '<div class="ask"><input id="pergunta" data-step="' + esc(id) + '" placeholder="' + esc(t('askPlaceholder')) + '" autocomplete="off">' +
    '<button data-perguntar="' + esc(id) + '">' + t('ask') + '</button></div><div id="resposta"></div></section>';
  box.innerHTML = html;
  box.scrollIntoView({ block: 'nearest' });
}
async function askQuestion(id) {
  const input = document.getElementById('pergunta');
  const out = document.getElementById('resposta');
  const question = input.value.trim();
  if (!question) return;
  const { c } = stepData.get(id);
  // Privacy: the exact request first; it is sent only after «Send», with the same fingerprint.
  let preview;
  try {
    preview = await (await fetch('/api/pergunta/preview', { method: 'POST', headers: { 'content-type': 'application/json', 'x-codetac': '1' },
      body: JSON.stringify({ requestId: c.req, stepId: id, question }) })).json();
  } catch (error) { out.innerHTML = '<p class="note">' + t('failedWith', { error: esc(error.message) }) + '</p>'; return; }
  if (preview.error || !preview.available || !preview.hash) {
    out.innerHTML = '<p class="note">' + esc(preview.error || preview.text) + (preview.blocked ? ' <a href="/privacy">' + t('privacy') + '</a>' : '') + '</p>';
    return;
  }
  out.innerHTML = '<div class="preview"><p class="note" style="margin:0 0 4px">' +
    t('exactlySent', { model: esc(preview.model), where: preview.local ? t('onThisComputer') : t('outside', { provider: esc(preview.provider) }) }) + '</p>' +
    '<pre class="code" id="perguntaTexto">' + esc(preview.text) + '</pre><details><summary class="note">' + t('instructions') + '</summary><pre class="code">' + esc(preview.system) + '</pre></details>' +
    '<button id="enviarPergunta">' + t('send') + '</button> <button id="cancelarPergunta">' + t('cancel') + '</button></div>';
  document.getElementById('cancelarPergunta').addEventListener('click', () => { out.innerHTML = ''; });
  document.getElementById('enviarPergunta').addEventListener('click', () => sendQuestion(id, question, preview.hash));
}
async function sendQuestion(id, question, hash) {
  const out = document.getElementById('resposta');
  const { c } = stepData.get(id);
  out.innerHTML = '<p class="note">' + t('thinking') + '</p>';
  try {
    const response = await fetch('/api/pergunta', { method: 'POST', headers: { 'content-type': 'application/json', 'x-codetac': '1' },
      body: JSON.stringify({ requestId: c.req, stepId: id, question, hash }) });
    const a = await response.json();
    if (a.error) { out.innerHTML = '<p class="note">' + esc(a.error) + '</p>'; return; }
    if (!a.available || a.changed) { out.innerHTML = '<p class="note">' + esc(a.text) + '</p>'; return; }
    const source = a.model ? t('answerFrom', { model: a.model }) + (a.local ? ' (' + t('localModelShort') + ')' : '') + (a.valuesSent ? ', ' + t('withValues')
      : a.valuesWithheld ? ', ' + t('withoutValues') : '.') : '';
    out.innerHTML = '<div class="answer' + (a.known ? '' : ' unknown') + (a.rejected ? ' rejected' : '') + '">' +
      (a.rejected ? '<p class="note" style="color:var(--error);margin:0 0 4px">' + t('unverified', { reason: esc(a.rejected) }) + '</p>' : '') +
      (!a.known ? '<p class="note" style="margin:0 0 4px">' + t('notEnough') + '</p>' : '') +
      '<p style="margin:0">' + esc(a.text) + '</p><p class="note" style="margin:4px 0 0">' + esc(source) + '</p></div>';
  } catch (error) {
    out.innerHTML = '<p class="note">' + t('failedWith', { error: esc(error.message) }) + '</p>';
  }
}

if (embed) { show(); }
else {
  loadRuns().then(async () => {
    if (selected) {
      const d = await (await fetch('/api/' + (selected.type === 'action' ? 'actions/' : 'requests/') + encodeURIComponent(selected.id))).json();
      if (d.request && d.request.run) runSelect.value = d.request.run;
      if (selected.type === 'request') tab = 'requests';
      if (d.run) runSelect.value = d.run;
      show();
    }
    loadList();
  });
  setInterval(() => loadRuns().then(loadList), 3000);
}
</script>
</body>
</html>`;
