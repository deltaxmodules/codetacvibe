// The structure endpoint of the panel (phase 2, step 6): /api/structure…
// Reads the project of a recording in the background (a worker thread, with
// the reader's incremental cache), keeps the last graph, and answers with the
// plan for the boxes the user opened. The panel only listens on 127.0.0.1 and
// checks the Host; these routes also refuse other origins and non-loopback
// sockets.
import { Worker } from 'node:worker_threads';
import { readFileSync, realpathSync, statSync, watch as watchFolder } from 'node:fs';
import { join, relative, sep, isAbsolute } from 'node:path';
import { planView } from './plan.mjs';
import { blockCard } from './card.mjs';
import { explanationRequest, explainCard } from './explain.mjs';
import { blocked, blockedText, guarded } from '../privacy.mjs';
import { traceAction, traceRequest } from './trace.mjs';
import { t } from './text.mjs';
import { SKIPPED_FOLDERS } from './node/inventory.mjs';
import { maskKeys } from './node/modules.mjs';
import { leaksView } from './leaks.mjs';
import { secretsView } from './secrets.mjs';
import { dataView } from './data.mjs';
import { healthView } from './smells.mjs';
import { serviceCatalogue } from './services.mjs';
import { readConfig } from './config.mjs';
import { listSnapshots, readSnapshot, saveSnapshot } from './snapshots.mjs';
import { changesView } from './changes.mjs';
import { alertFacts, planFacts, withKeys } from './facts.mjs';
import { readPoint, recentCommits } from './commits.mjs';
import { cleanPrediction, predictionChoices } from './predict.mjs';
import { answerQuestion, quizQuestions, readResults, withoutAnswers } from './quiz.mjs';
import { changeSentences, markReviewed, readReview, reviewDebt, sentenceKey } from './review.mjs';

const MAX_SEARCH = 50;
// While a project is watched, it is still read again after this long (a
// change the watcher missed); otherwise after maxAge.
const WATCHED_MAX_AGE = 5 * 60_000;

// Watch mode (phase 12, step 2): changed() on any change in the project,
// except dependencies, builds and .git. Returns stop(), or null when the
// folder cannot be watched (the plan is then read again by age).
export function watchProject(root, changed, failed = () => {}) {
  try {
    const watcher = watchFolder(root, { recursive: true, persistent: false }, (event, name) => {
      if (name && String(name).split(/[\\/]/).some(part => SKIPPED_FOLDERS.has(part))) return;
      changed(name ? String(name) : null);
    });
    watcher.on('error', () => { watcher.close(); failed(); });
    return () => watcher.close();
  } catch { return null; }
}

export function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

// rootOf(run) → the project folder of a recording, or null.
// ai: { config, complete } for the optional explanations (config.provider
// empty when no model is configured).
// recordings (phase 7): { actions(run) → [{ actionId, label, at }], action(id) → resolved dossier,
// request(id) → request dossier }, so the plan can show where an action went.
// watch: watchProject, or null for reading by age only; settle: ms of quiet
// after a change before reading again.
export function createStructureService({ rootOf, maxAge = 10_000, read = readInWorker, now = () => Date.now(), editor = null, ai = null, recordings = null,
  watch = watchProject, settle = 300 }) {
  const explanations = new Map();
  // Graphs of commits compared in the Changes view (phase 9): a commit never changes.
  const commitGraphs = new Map();
  const MAX_COMMITS = 8;
  const traces = new Map();
  const MAX_SESSION_ACTIONS = 50;

  // The trace of one action or request, cached while the graph and the dossier stay the same.
  async function traceOf(entry, { action, request }) {
    const key = `${action ? `a:${action}` : `r:${request}`}:${entry.readAt}`;
    if (traces.has(key)) return traces.get(key);
    const dossier = action ? await recordings?.action?.(action) : await recordings?.request?.(request);
    if (!dossier) return null;
    const trace = action ? traceAction(entry.graph, dossier) : traceRequest(entry.graph, dossier);
    const result = { ...trace, label: action ? dossier.label : `${dossier.request?.method ?? ''} ${dossier.request?.path ?? ''}`.trim(),
      steps: trace.steps.map(({ step, ...rest }) => rest) };
    if (!dossier.pending) traces.set(key, result);
    return result;
  }
  async function sessionTraces(entry, run) {
    const list = (await recordings?.actions?.(run) ?? []).slice(0, MAX_SESSION_ACTIONS);
    const out = [];
    for (const item of list) {
      const trace = await traceOf(entry, { action: item.actionId });
      if (trace) out.push({ item, trace });
    }
    return out;
  }
  // What this session saw going out (phase 4): the server's calls to other
  // hosts (with the names of the fields sent) and the browser's requests to
  // other sites, in the last actions.
  async function observedCalls(run) {
    const server = (await recordings?.outgoing?.(run) ?? []).map(call => ({ host: call.host, fields: call.fields, source: 'server' }));
    const browser = [];
    for (const item of (await recordings?.actions?.(run) ?? []).slice(0, MAX_SESSION_ACTIONS)) {
      const dossier = await recordings.action?.(item.actionId);
      for (const step of dossier?.timeline ?? []) {
        if (step.type === 'request' && step.browser?.sameOrigin === false && step.browser.host) browser.push({ host: step.browser.host, fields: null, source: 'browser' });
      }
    }
    return [...server, ...browser];
  }
  const projects = new Map();

  function start(root, entry) {
    const began = now();
    entry.changed = false;
    entry.promise = read(root).then(result => {
      if (result.error) entry.error = result.error;
      else Object.assign(entry, { graph: result.graph, problems: result.problems ?? [], readAt: now(), readMs: now() - began, error: null });
    }, error => { entry.error = String(error?.message ?? error); })
      .finally(() => {
        entry.promise = null;
        // Changes made during the read: read again.
        if (entry.changed && !entry.timer) start(root, entry);
      });
    return entry.promise;
  }
  // A change in a watched project: read again once it has been quiet for `settle` ms.
  function changed(root, entry) {
    entry.changed = true;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { entry.timer = null; if (!entry.promise && entry.changed) start(root, entry); }, settle);
    entry.timer.unref?.();
  }
  // The entry of a project, (re)reading it when there is no graph yet or the
  // last one is too old. Waits at most `wait` ms for a first read.
  async function project(root, { wait = 0 } = {}) {
    if (!projects.has(root)) {
      const entry = { graph: null, readAt: 0, readMs: 0, promise: null, error: null, problems: [], watching: false, changed: false, timer: null };
      projects.set(root, entry);
      const stop = watch ? watch(root, () => changed(root, entry), () => { entry.watching = false; }) : null;
      entry.watching = Boolean(stop);
      entry.stop = stop;
    }
    const entry = projects.get(root);
    if (!entry.promise && (!entry.graph || now() - entry.readAt > (entry.watching ? WATCHED_MAX_AGE : maxAge))) start(root, entry);
    if (!entry.graph && entry.promise && wait > 0) await Promise.race([entry.promise, new Promise(resolve => setTimeout(resolve, wait).unref?.())]);
    return entry;
  }
  function close() {
    for (const entry of projects.values()) { entry.stop?.(); clearTimeout(entry.timer); }
    projects.clear();
  }

  function summary(entry) {
    const files = entry.graph.nodes.filter(node => node.kind === 'file');
    return {
      status: 'ready', reading: Boolean(entry.promise), watching: entry.watching, project: entry.graph.project, readAt: entry.readAt, readMs: entry.readMs,
      files: files.length, unknown: files.filter(file => file.block === 'block:unknown').length,
      notes: (entry.graph.notes ?? []).length, problems: entry.problems,
    };
  }

  // What to open to show a node: its block, then its file.
  function reveal(graph, node) {
    const byId = new Map(graph.nodes.map(item => [item.id, item]));
    const exposedBy = node.kind === 'route' ? graph.edges.find(edge => edge.kind === 'exposes' && edge.to === node.id)?.from : null;
    const fileId = node.kind === 'file' ? node.id : node.kind === 'symbol' ? node.file : exposedBy;
    const file = fileId ? byId.get(fileId) : null;
    if (node.kind === 'block') return [];
    if (!file) return [];
    return node.kind === 'file' ? [file.block] : [file.block, file.id];
  }

  // The node of a step shown in a dossier (path#function@line), and what to open to see it.
  function focusOf(graph, trace, focus) {
    if (!focus) return {};
    const step = trace.steps.find(item => `${item.file}#${item.function}@${item.line}` === focus);
    const node = step ? graph.nodes.find(item => item.id === step.node) : null;
    return node ? { focus: { node: node.id, open: reveal(graph, node) } } : { focus: { node: null } };
  }

  // The views with alerts, each alert with its key (phase 10). Structure
  // health reads the code files (duplication): kept per reading of the project.
  function secretsOf(entry, root) {
    const view = secretsView(entry.graph, { root, platform: readConfig(root).env.platform });
    return { ...view, alerts: withKeys('secrets', view.alerts), warnings: withKeys('secrets', view.warnings) };
  }
  function dataOf(entry) {
    const view = dataView(entry.graph);
    return { ...view, alerts: withKeys('data', view.alerts), warnings: withKeys('data', view.warnings) };
  }
  function healthOf(entry, root) {
    const thresholds = readConfig(root).smells;
    const key = `${entry.readAt}:${JSON.stringify(thresholds)}`;
    if (entry.health?.key !== key) {
      const view = healthView(entry.graph, { root, thresholds });
      entry.health = { key, view: { ...view, smells: withKeys('health', view.smells) } };
    }
    return entry.health.view;
  }
  // Phase 10, step 4: the comprehension debt — the changes against the newest
  // snapshot not opened yet, plus those carried from before it. The sentences
  // are kept per reading of the project and snapshot.
  function debtOf(entry, root) {
    const newest = listSnapshots(root)[0] ?? null;
    if (!newest) return { snapshot: null, ...reviewDebt(readReview(root)) };
    const key = `${entry.readAt}:${newest.id}:${newest.createdAt}`;
    if (entry.review?.key !== key) {
      const before = readSnapshot(root, newest.id);
      entry.review = { key, sentences: before ? changeSentences(before.graph, entry.graph) : [] };
    }
    return { snapshot: newest.id, ...reviewDebt(readReview(root), { snapshot: newest.id, sentences: entry.review.sentences }) };
  }
  async function alertsOf(entry, root, source, snapshot) {
    if (source === 'secrets') { const view = secretsOf(entry, root); return [...view.alerts, ...view.warnings]; }
    if (source === 'data') { const view = dataOf(entry); return [...view.alerts, ...view.warnings]; }
    if (source === 'health') return healthOf(entry, root).smells;
    if (source === 'changes') {
      const side = /^[0-9a-f]{40}$/.test(snapshot ?? '') ? commitGraphs.get(`${root}\n${snapshot}`) : await readPoint(root, snapshot || 'latest', { readSnapshot });
      if (!side?.graph) return [];
      return withKeys('changes', changesView(side.graph, entry.graph).sentences);
    }
    return [];
  }

  async function handle(pathname, params, { method = 'GET', body = null } = {}) {
    const run = params.get('run');
    const root = run ? rootOf(run) : null;
    if (!run) return { status: 400, body: { error: t('service.noRun') } };
    if (!root) return { status: 404, body: { error: t('service.noFolder') } };
    // The secret filter hid part of the folder's path (a name that looks like a key, M30/M131).
    if (root.includes('[REDACTED]')) {
      return { status: 404, body: { error: t('service.folderHidden') } };
    }
    try { if (!statSync(root).isDirectory()) throw new Error(); } catch { return { status: 404, body: { error: t('service.folderGone') } }; }
    const entry = await project(root, { wait: Number(params.get('wait')) > 0 ? Math.min(Number(params.get('wait')), 30_000) : 0 });
    if (!entry.graph) {
      return entry.error ? { status: 500, body: { status: 'error', error: entry.error } } : { status: 202, body: { status: 'reading' } };
    }
    if (pathname === '/api/structure') return { status: 200, body: summary(entry) };
    if (pathname === '/api/structure/plan') {
      const open = (params.get('open') ?? '').split(',').map(item => item.trim()).filter(Boolean).slice(0, 500);
      const wanted = params.get('action') ? { action: params.get('action') } : params.get('request') ? { request: params.get('request') } : null;
      const trace = wanted ? await traceOf(entry, wanted) : null;
      let covered = null;
      let sessionActions = 0;
      if (params.get('coverage') === '1') {
        const session = await sessionTraces(entry, run);
        sessionActions = session.length;
        covered = session.flatMap(({ trace: item }) => [...item.edges, ...item.inferred]);
      }
      return { status: 200, body: { ...summary(entry), plan: planView(entry.graph, { expanded: open, trace, covered }),
        ...(trace ? { trace: { label: trace.label, nodes: trace.nodes, unmatched: trace.unmatched, steps: trace.steps, observed: trace.observed.length, inferred: trace.inferred.length,
          ...focusOf(entry.graph, trace, params.get('focus')) } } : {}),
        ...(wanted && !trace ? { traceError: t('service.actionMissing') } : {}),
        ...(covered ? { sessionActions } : {}) } };
    }
    if (pathname === '/api/structure/leaks') {
      const catalogue = serviceCatalogue(readConfig(root).services);
      return { status: 200, body: { ...summary(entry), leaks: leaksView(entry.graph, { catalogue, observed: await observedCalls(run) }) } };
    }
    // Every alert has a key (phase 10): its «Explain» asks for it by that key.
    if (pathname === '/api/structure/secrets') return { status: 200, body: { ...summary(entry), secrets: secretsOf(entry, root) } };
    if (pathname === '/api/structure/health') return { status: 200, body: { ...summary(entry), health: healthOf(entry, root) } };
    if (pathname === '/api/structure/data') return { status: 200, body: { ...summary(entry), data: dataOf(entry) } };
    // Phase 9: what changed since a snapshot (the newest by default) or a
    // commit (read from a temporary copy, kept in memory by its hash), and saving a snapshot.
    if (pathname === '/api/structure/diff') {
      const snapshots = listSnapshots(root);
      const commits = recentCommits(root);
      const wanted = params.get('snapshot') || 'latest';
      const open = (params.get('open') ?? '').split(',').map(item => item.trim()).filter(Boolean).slice(0, 500);
      const isCommit = /^[0-9a-f]{40}$/.test(wanted);
      let side = null;
      if (isCommit) {
        const key = `${root}\n${wanted}`;
        if (!commitGraphs.has(key)) {
          const read = await readPoint(root, wanted, { readSnapshot });
          if (read.error) return { status: 404, body: { error: read.error } };
          commitGraphs.set(key, read);
          if (commitGraphs.size > MAX_COMMITS) commitGraphs.delete(commitGraphs.keys().next().value);
        }
        side = commitGraphs.get(key);
      } else if (snapshots.length) {
        const read = await readPoint(root, wanted, { readSnapshot });
        if (!read.error) side = read;
      }
      if (!side) return { status: 200, body: { ...summary(entry), diff: { snapshots, commits, against: null, missing: snapshots.length ? wanted : null }, review: debtOf(entry, root) } };
      const against = side.point;
      const key = `${entry.readAt}:${against.id ?? against.commit}:${against.createdAt ?? ''}:${open.join(',')}`;
      if (entry.changes?.key !== key) entry.changes = { key, view: changesView(side.graph, entry.graph, { expanded: open, prediction: against.prediction ?? null }) };
      // Each sentence says whether it was opened (against a snapshot), and the
      // changes carried from before the newest snapshot come along.
      const reviewed = new Set(against.id ? readReview(root).reviewed[against.id] ?? [] : []);
      const sentences = withKeys('changes', entry.changes.view.sentences).map(sentence => ({ ...sentence, reviewKey: sentenceKey(sentence),
        ...(against.id ? { reviewed: reviewed.has(sentenceKey(sentence)) } : {}) }));
      return { status: 200, body: { ...summary(entry), diff: { snapshots, commits, against, ...entry.changes.view, sentences }, review: debtOf(entry, root) } };
    }
    if (pathname === '/api/structure/snapshot') {
      if (method !== 'POST') return { status: 405, body: { error: t('service.usePost') } };
      const label = typeof body?.label === 'string' ? body.label : null;
      // Phase 10: the user's prediction of the next change, saved with it.
      const prediction = cleanPrediction(body?.prediction);
      const saved = await saveSnapshot(root, { label, graph: entry.graph, prediction });
      return { status: 200, body: { snapshot: saved.snapshot, replaced: saved.replaced, removed: saved.removed } };
    }
    // What «Predict» offers to choose from (phase 10).
    if (pathname === '/api/structure/predict/choices') {
      return { status: 200, body: predictionChoices(entry.graph, serviceCatalogue(readConfig(root).services).services) };
    }
    // Phase 10, step 4: the comprehension debt, and opening a change.
    if (pathname === '/api/structure/review') {
      if (method === 'POST') {
        const snapshot = typeof body?.snapshot === 'string' ? body.snapshot : null;
        markReviewed(root, { snapshot, keys: body?.keys ?? [] });
      }
      return { status: 200, body: { review: debtOf(entry, root) } };
    }
    // Phase 10: the quiz. Questions go without their answers; an answer comes
    // back with the right one and its proof, and is counted on this machine.
    if (pathname === '/api/structure/quiz') {
      const round = Math.max(0, Math.min(Number.parseInt(params.get('round') ?? '0', 10) || 0, 1e6));
      return { status: 200, body: { ...summary(entry), quiz: { round, questions: withoutAnswers(quizQuestions(entry.graph, { round })), results: readResults(root) } } };
    }
    if (pathname === '/api/structure/quiz/answer') {
      if (method !== 'POST') return { status: 405, body: { error: t('service.usePost') } };
      const round = Math.max(0, Math.min(Number.parseInt(body?.round ?? 0, 10) || 0, 1e6));
      const verdict = answerQuestion(entry.graph, root, { round, id: String(body?.id ?? ''), choice: body?.choice });
      return verdict ? { status: 200, body: verdict } : { status: 404, body: { error: 'changed' } };
    }
    if (pathname === '/api/structure/trace') {
      const wanted = params.get('action') ? { action: params.get('action') } : params.get('request') ? { request: params.get('request') } : null;
      const trace = wanted ? await traceOf(entry, wanted) : null;
      return trace ? { status: 200, body: trace } : { status: 404, body: { error: t('service.actionMissing') } };
    }
    if (pathname === '/api/structure/search') {
      const query = (params.get('q') ?? '').trim().toLowerCase();
      if (!query) return { status: 200, body: { results: [] } };
      const results = entry.graph.nodes
        .filter(node => ['block', 'file', 'symbol', 'route'].includes(node.kind) && `${node.name} ${node.path ?? ''}`.toLowerCase().includes(query))
        .sort((a, b) => (a.name.toLowerCase() === query ? 0 : 1) - (b.name.toLowerCase() === query ? 0 : 1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, MAX_SEARCH)
        .map(node => ({ id: node.id, kind: node.kind, name: node.name, ...(node.path ? { path: node.path } : {}),
          ...(node.kind === 'symbol' ? { file: node.file.slice(5), line: node.line } : {}), open: reveal(entry.graph, node) }));
      return { status: 200, body: { results } };
    }
    if (pathname === '/api/structure/card') {
      const card = blockCard(entry.graph, params.get('block') ?? '');
      if (!card) return { status: 404, body: { error: t('service.noBlock') } };
      // Actions of this session that went through the block.
      const members = new Set(entry.graph.nodes.filter(node => node.kind === 'file' && node.block === card.id).map(node => node.id));
      const inBlock = id => members.has(id) || members.has(entry.graph.nodes.find(node => node.id === id)?.file);
      const actions = (await sessionTraces(entry, run)).filter(({ trace }) => trace.nodes.some(inBlock))
        .map(({ item }) => ({ actionId: item.actionId, label: item.label, at: item.at }));
      return { status: 200, body: { ...card, actions } };
    }
    // Explanations: the preview is the exact request; sending needs its fingerprint.
    // kind: block (phase 3), plan or alert (phase 10; alert: source + key, and snapshot for a change).
    if (pathname === '/api/structure/explain/preview' || pathname === '/api/structure/explain') {
      const preview = pathname.endsWith('/preview');
      const ask = name => (preview ? params.get(name) : body?.[name]) ?? null;
      const kind = ask('kind') || 'block';
      let card = null;
      if (kind === 'block') card = blockCard(entry.graph, ask('block') ?? '');
      else if (kind === 'plan') card = planFacts(entry.graph, { secrets: secretsOf(entry, root), data: dataOf(entry), health: healthOf(entry, root) });
      else if (kind === 'alert') {
        const source = ask('source');
        const item = (await alertsOf(entry, root, source, ask('snapshot'))).find(alert => alert.key === ask('key'));
        card = item ? alertFacts(source, item, entry.graph) : null;
      } else return { status: 400, body: { error: t('service.unknownExplanation') } };
      if (!card) return { status: 404, body: { error: kind === 'alert' ? t('service.findingGone') : t('service.noBlock') } };
      if (!ai?.config?.provider) return { status: 200, body: { active: false, problem: ai?.config?.problem ?? t('service.noModel') } };
      // Privacy (phase 10, step 5): switched off, or «No AI».
      const reason = blocked('explanations', ai.config);
      if (reason) return { status: 200, body: { active: false, blocked: reason, problem: blockedText(reason) } };
      const request = explanationRequest(card, entry.graph.project, kind);
      const who = { active: true, provider: ai.config.provider, model: ai.config.model, local: Boolean(ai.config.local) };
      if (preview) return { status: 200, body: { ...who, ...request, cached: explanations.get(`${request.hash}:${ai.config.model}`) ?? null } };
      if (method !== 'POST') return { status: 405, body: { error: t('service.usePost') } };
      if (body?.hash !== request.hash) return { status: 409, body: { error: t('service.factsChanged') } };
      const key = `${request.hash}:${ai.config.model}`;
      if (!explanations.has(key)) {
        try { explanations.set(key, await explainCard({ config: ai.config, request, card, complete: guarded('explanations', ai.complete) })); } catch (error) {
          return { status: 502, body: { error: t('service.noAnswer', { reason: String(error?.message ?? error).slice(0, 200) }) } };
        }
      }
      return { status: 200, body: { ...who, hash: request.hash, ...explanations.get(key) } };
    }
    if (pathname === '/api/structure/source') {
      const result = excerpt(root, entry.graph, params.get('file'), Number(params.get('line')));
      return result ? { status: 200, body: result } : { status: 404, body: { error: t('service.noCode') } };
    }
    return { status: 404, body: { error: t('service.notFound') } };
  }

  // The lines around a proof. Only files of the graph, never .env files or
  // hidden files (their content is never shown), never outside the project.
  function excerpt(root, graph, file, line) {
    const node = graph.nodes.find(item => item.kind === 'file' && item.path === file);
    if (!node || node.language === 'dotenv' || file.split('/').some(part => part.startsWith('.')) || !Number.isInteger(line) || line < 1) return null;
    let real;
    try { real = realpathSync(join(root, file)); } catch { return null; }
    const within = relative(realpathSync(root), real);
    if (!within || within.startsWith(`..${sep}`) || within === '..' || isAbsolute(within)) return null;
    const lines = readFileSync(real, 'utf8').split('\n');
    if (line > lines.length) return null;
    const start = Math.max(1, line - 6);
    const end = Math.min(lines.length, line + 12);
    // Keys written in the code are masked (principle 4): the prefix stays.
    return { file, line, start, end, lines: lines.slice(start - 1, end).map(maskKeys),
      ...(editor ? { editorUrl: `${editor}://file${encodeURI(real)}:${line}:1` } : {}) };
  }

  return { handle, project, close };
}

function readInWorker(root) {
  return new Promise(resolve => {
    const worker = new Worker(new URL('./read-worker.mjs', import.meta.url), { workerData: { root } });
    let answered = false;
    worker.once('message', message => { answered = true; resolve(message); worker.terminate(); });
    worker.once('error', error => { if (!answered) resolve({ error: String(error?.message ?? error) }); });
    worker.once('exit', code => { if (!answered) resolve({ error: t('service.readerStopped', { code }) }); });
  });
}
