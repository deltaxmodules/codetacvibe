// Vista agrupada do dossiê (Fase 3): árvore de passos com o ruído agrupado,
// uma frase de finalidade por função e por fronteira, e o resumo dos efeitos
// permanentes. Tudo deriva dos factos gravados; nada é removido, só agrupado
// (cada grupo guarda os passos originais para a expansão).
import { boundarySentence, duration, names, texts } from './sentences.mjs';

const STRUCTURE = new Set(['CREATE', 'DROP', 'ALTER', 'TRUNCATE']);
const WRITES = new Set(['INSERT', 'UPDATE', 'DELETE', 'UPSERT', 'REPLACE', 'MERGE']);
const TRIVIAL_MS = 5;
const TRIVIAL_LINES = 10;
// Requests made by the development tooling, not by the application.
const DEV_TOOLS = /(\.hot-update\.(json|js)$|\/_next\/webpack-hmr|\/__nextjs_|\/__webpack_hmr|\/@vite\/|\/@react-refresh|\/__vite_ping|\/_next\/static\/webpack\/)/;

export function isDevToolRequest(path) { return DEV_TOOLS.test(path ?? ''); }

function tree(steps) {
  const ids = new Map(steps.map(step => [step.id, { ...step, children: [] }]));
  const roots = [];
  for (const step of steps) {
    const node = ids.get(step.id);
    const parent = step.parentId ? ids.get(step.parentId) : null;
    (parent ? parent.children : roots).push(node);
  }
  return roots;
}

// Everything the subtree of a node did outside the project's code.
function collect(node, into = { boundaries: [], functions: 0, errors: 0 }) {
  for (const child of node.children ?? []) {
    if (child.type === 'boundary') into.boundaries.push(child);
    else into.functions++;
    if (child.error) into.errors++;
    collect(child, into);
  }
  return into;
}

function signature(node) {
  if (node.type === 'group') return `g:${node.group}:${signature(node.children[0])}`;
  if (node.type === 'function') return `f:${node.file}:${node.line}`;
  return `b:${node.kind}:${node.operation}:${(node.tables ?? []).join(',')}:${node.provider ?? ''}:${node.host ?? ''}:${node.method ?? ''}:${node.path ?? ''}`;
}
function generated(node, root) {
  if (node.type !== 'function' || !node.file) return false;
  const within = root && node.file.startsWith(root + '/') ? node.file.slice(root.length + 1) : node.file;
  return within.split('/').slice(0, -1).some(part => part.startsWith('.'));
}
function trivial(node) {
  return node.type === 'function' && !node.children.length && !node.error && !node.detail && node.finished !== false
    && (node.durationMs ?? 0) < TRIVIAL_MS && (node.endLine == null || node.endLine - node.line <= TRIVIAL_LINES);
}
const sum = (nodes, key = 'durationMs') => nodes.reduce((total, node) => total + (node[key] ?? 0), 0);

// Groups consecutive siblings; the order of the sequence is kept.
function group(children, parent, ctx) {
  const t = texts(ctx.lang);
  const out = [];
  let index = 0;
  while (index < children.length) {
    const node = children[index];
    // 1. Database setup: a run of structure commands (M14).
    if (node.type === 'boundary' && node.kind === 'base-de-dados') {
      let end = index;
      while (end < children.length && children[end].type === 'boundary' && children[end].kind === 'base-de-dados') end++;
      const run = children.slice(index, end);
      const structure = run.filter(item => STRUCTURE.has(item.operation));
      if (run.length >= 3 && structure.length * 2 >= run.length) {
        const counts = {};
        for (const item of run) counts[item.operation] = (counts[item.operation] ?? 0) + 1;
        const tables = new Set(run.flatMap(item => item.tables ?? []));
        const failed = run.filter(item => item.error || item.result?.error).length;
        const changed = run.filter(item => WRITES.has(item.operation)).reduce((total, item) => total + (item.result?.affectedRows ?? 0), 0);
        const parentOk = parent && parent.type === 'function' && parent.finished && !parent.error;
        out.push({ type: 'group', group: 'preparacao-bd', id: `g:${run[0].id}`, count: run.length, durationMs: sum(run), errors: failed,
          sentence: t.dbSetup(run.length, Object.entries(counts).map(([op, n]) => `${n} ${op}`).join(', '), tables.size, failed, changed, parentOk),
          children: run });
        index = end;
        continue;
      }
    }
    // 2. Bundler glue, two or more in a row (before repetitions: glue often
    // repeats the same wrapper).
    let end = index + 1;
    if (generated(node, ctx.root)) {
      while (end < children.length && generated(children[end], ctx.root)) end++;
      if (end - index >= 2) {
        const run = children.slice(index, end);
        out.push({ type: 'group', group: 'gerado', id: `g:${node.id}`, count: run.length, durationMs: sum(run), errors: run.filter(item => item.error).length,
          sentence: t.generated(run.length), children: run });
        index = end;
        continue;
      }
      end = index + 1;
    }
    // 3. The same step repeated in a row.
    while (end < children.length && signature(children[end]) === signature(node)) end++;
    if (end - index >= 2) {
      const run = children.slice(index, end);
      out.push({ type: 'group', group: 'repeticao', id: `g:${node.id}`, count: run.length, durationMs: sum(run),
        errors: run.filter(item => item.error).length, sentence: t.repeated(node.purpose.text, run.length), first: node, children: run });
      index = end;
      continue;
    }
    // 4. Trivial helpers, two or more in a row.
    if (trivial(node) && !generated(node, ctx.root)) {
      end = index + 1;
      while (end < children.length && trivial(children[end]) && !generated(children[end], ctx.root)) end++;
      if (end - index >= 2) {
        const run = children.slice(index, end);
        const fns = [...new Set(run.map(item => item.function))];
        out.push({ type: 'group', group: 'auxiliares', id: `g:${node.id}`, count: run.length, durationMs: sum(run), errors: run.filter(item => item.error).length,
          sentence: t.helpers(run.length, names(fns, t.and)), children: run });
        index = end;
        continue;
      }
    }
    out.push(node);
    index++;
  }
  return blocks(out, ctx);
}

// The same sequence of 2 to 6 steps repeated in a row (a loop over records):
// one line, with every step kept in order for the expansion.
function blocks(nodes, ctx) {
  const t = texts(ctx.lang);
  const out = [];
  let index = 0;
  while (index < nodes.length) {
    let best = null;
    for (let size = 2; size <= 6 && index + size * 2 <= nodes.length; size++) {
      const pattern = nodes.slice(index, index + size).map(signature);
      let times = 1;
      while (index + (times + 1) * size <= nodes.length
        && nodes.slice(index + times * size, index + (times + 1) * size).every((node, i) => signature(node) === pattern[i])) times++;
      if (times >= 2 && (!best || times * size > best.times * best.size)) best = { size, times };
    }
    if (!best) { out.push(nodes[index++]); continue; }
    const run = nodes.slice(index, index + best.size * best.times);
    const first = nodes.slice(index, index + best.size);
    const inside = run.flatMap(node => [node, ...collect(node).boundaries]).filter(node => node.type === 'boundary');
    const reads = [...new Set(inside.filter(item => item.kind === 'base-de-dados' && item.operation === 'SELECT').flatMap(item => item.tables ?? []))];
    const writes = [...new Set(inside.filter(item => item.kind === 'base-de-dados' && WRITES.has(item.operation)).flatMap(item => item.tables ?? []))];
    const fns = [...new Set(first.flatMap(node => node.type === 'function' ? [node.function] : node.type === 'group' && node.children[0].type === 'function' ? [node.children[0].function] : []))];
    const parts = [];
    if (reads.length) parts.push(t.readPart(names(reads, t.and)));
    if (writes.length) parts.push(t.writePart(t.writeVerbs.UPDATE, names(writes, t.and)));
    if (fns.length) parts.push(t.calls(names(fns, t.and)));
    out.push({ type: 'group', group: 'bloco', id: `g:b:${run[0].id}`, count: run.length, durationMs: sum(run), errors: run.filter(item => item.error || item.errors).length,
      sentence: t.block(best.times, best.size, parts.join(' · ')), children: run });
    index += run.length;
  }
  return out;
}

// What a function did, from the boundaries in its subtree and the functions it called.
function functionSentence(node, ctx) {
  const t = texts(ctx.lang);
  const facts = collect(node);
  const parts = [];
  const db = facts.boundaries.filter(item => item.kind === 'base-de-dados');
  const structure = db.filter(item => STRUCTURE.has(item.operation));
  if (structure.length) parts.push(t.dbSetupPart(structure.length));
  const reads = [...new Set(db.filter(item => item.operation === 'SELECT').flatMap(item => item.tables ?? []))];
  if (reads.length) parts.push(t.readPart(names(reads, t.and)));
  // Writes that changed no rows (or failed) are not presented as changes.
  const idle = new Set();
  for (const op of WRITES) {
    const writes = db.filter(item => item.operation === op);
    const done = writes.filter(item => !item.error && !item.result?.error && item.result?.affectedRows !== 0);
    const tables = [...new Set(done.flatMap(item => item.tables ?? []))];
    if (tables.length) parts.push(t.writePart(t.writeVerbs[op], names(tables, t.and)));
    for (const item of writes) if (!done.includes(item)) for (const table of item.tables ?? []) if (!tables.includes(table)) idle.add(table);
  }
  if (idle.size) parts.push(t.idleWritePart(names([...idle], t.and)));
  const kinds = kind => facts.boundaries.filter(item => item.kind === kind);
  const hosts = [...new Set(kinds('http').map(item => item.host))];
  if (hosts.length) parts.push(t.httpPart(names(hosts, t.and)));
  const ai = [...new Set(kinds('ia').map(item => item.provider))];
  if (ai.length) parts.push(t.aiPart(names(ai, t.and)));
  const mail = kinds('email').length + kinds('mensagem').length;
  if (mail) parts.push(t.emailPart(mail));
  const pay = [...new Set(kinds('pagamento').map(item => item.provider))];
  if (pay.length) parts.push(t.paymentPart(names(pay, t.and)));
  const files = [...new Set(kinds('ficheiros').map(item => item.operation))];
  if (files.length) parts.push(t.filePart(names(files, t.and)));
  const auth = [...new Set(kinds('autenticação').map(item => item.provider ?? item.library))];
  if (auth.length) parts.push(t.authPart(names(auth, t.and)));
  const callees = [...new Set(node.children.filter(item => item.type === 'function' && !generated(item, ctx.root)).map(item => item.function))];
  if (!facts.boundaries.length) parts.push(t.noBoundary);
  if (callees.length) parts.push(t.calls(names(callees, t.and)));
  if (node.error) parts.push(t.error);
  else if (node.finished === false) parts.push(t.unfinished);
  const text = parts.join(' · ');
  return text[0].toUpperCase() + text.slice(1);
}

function annotate(node, ctx) {
  for (const child of node.children) annotate(child, ctx);
  node.purpose = { text: node.type === 'function' ? functionSentence(node, ctx) : boundarySentence(node, ctx.lang), source: 'factos' };
  node.children = group(node.children, node, ctx);
  return node;
}

function counts(nodes) {
  let visible = 0;
  let total = 0;
  const walk = (list, open) => {
    for (const node of list) {
      if (node.type === 'group') {
        if (open) visible++;
        walk(node.children, false);
      } else {
        total++;
        if (open) visible++;
        walk(node.children ?? [], open);
      }
    }
  };
  walk(nodes, true);
  return { visible, total };
}

// Lasting effects of the steps of one or more requests.
export function effects(dossiers, lang, { cookies = [] } = {}) {
  const t = texts(lang).effects;
  const items = [];
  const add = (key, category, make, amount = 1) => {
    let found = items.find(item => item.key === key);
    if (!found) items.push(found = { key, category, n: 0, total: null, make });
    found.n++;
    if (amount != null) found.total = (found.total ?? 0) + amount;
    else found.unknown = true;
  };
  let structureOk = 0;
  let structureFailed = 0;
  const steps = dossiers.flatMap(dossier => dossier.steps ?? []);
  for (const step of steps) {
    if (step.type !== 'boundary') continue;
    const r = step.result ?? {};
    const failed = Boolean(step.error || r.error);
    const table = (step.tables ?? []).join(', ') || '?';
    if (step.kind === 'base-de-dados' && STRUCTURE.has(step.operation)) {
      if (failed) structureFailed++; else structureOk++;
    } else if (step.kind === 'base-de-dados' && WRITES.has(step.operation) && !failed) {
      const n = r.affectedRows;
      if (n === 0) add(`none:${step.operation}:${table}`, 'sem-alteracao', (item) => t.noChange(step.operation, table, item.n));
      else {
        const make = step.operation === 'INSERT' ? item => t.added(item.unknown ? null : item.total, table)
          : step.operation === 'UPDATE' ? item => t.changed(item.unknown ? null : item.total, table)
          : step.operation === 'DELETE' ? item => t.deleted(item.unknown ? null : item.total, table)
          : () => t.otherWrite(step.operation, table);
        add(`db:${step.operation}:${table}`, 'base-de-dados', make, n ?? null);
      }
    } else if (step.kind === 'email') add(`mail:${step.id}`, 'email', () => t.email(step.to ?? [], step.subject, failed));
    else if (step.kind === 'mensagem') add(`msg:${step.id}`, 'email', () => t.message(step.provider ?? step.library, failed));
    else if (step.kind === 'pagamento' && !failed) add(`pay:${step.id}`, 'pagamento', () => t.payment(step.provider, step.operation, step.mode));
    else if (step.kind === 'ficheiros' && !failed && !['leitura', 'verificação', 'GET', 'HEAD'].includes(step.operation)) {
      const where = step.bucket ? `${step.provider} ${step.bucket}` : step.path ?? step.provider;
      add(`file:${step.operation}:${where}`, 'ficheiros', () => t.file(step.operation, where));
    } else if (step.kind === 'ia') add(`ia:${step.id}`, 'custo', () => t.ai(step.provider, r.model ?? step.model, r.usage, step.costUsd));
    else if (step.kind === 'http' && !step.local && !failed) {
      add(`http:${step.method}:${step.host}`, step.method === 'GET' || step.method === 'HEAD' ? 'leitura-externa' : 'externo',
        item => t.external(step.method, step.host, item.n));
    }
  }
  const set = [...new Set(cookies.filter(item => !item.cleared).map(item => item.name))];
  const cleared = [...new Set(cookies.filter(item => item.cleared).map(item => item.name))];
  const result = items.map(item => ({ category: item.category, text: item.make(item) }));
  if (set.length) result.push({ category: 'browser', text: t.cookieSet(set.join(', ')) });
  if (cleared.length) result.push({ category: 'browser', text: t.cookieCleared(cleared.join(', ')) });
  if (structureOk + structureFailed) result.push({ category: 'estrutura', text: t.structure(structureOk, structureFailed) });
  const lasting = result.filter(item => !['sem-alteracao', 'leitura-externa', 'custo'].includes(item.category));
  return { items: result, lasting: lasting.length, none: lasting.length ? null : t.none, unseen: t.unseen };
}

// The grouped view of one request dossier.
export function digestRequest(dossier, { lang = 'pt-PT' } = {}) {
  const ctx = { lang, root: dossier.root };
  const roots = tree(dossier.steps ?? []);
  const pseudo = { type: 'request', children: roots };
  for (const node of roots) annotate(node, ctx);
  const nodes = group(roots, pseudo, ctx);
  return { nodes, lines: counts(nodes), effects: effects([dossier], lang, { cookies: dossier.request?.cookies ?? [] }),
    duration: duration(dossier.request?.durationMs, lang) };
}

// A whole action: every server dossier grouped, development-tool requests
// grouped (M8), a one-line summary and the effects of all its requests.
export function digestAction(dossier, { lang = 'pt-PT' } = {}) {
  const t = texts(lang);
  const servers = [];
  const timeline = [];
  for (const item of dossier.timeline) {
    for (const server of item.server ?? []) {
      server.digest = digestRequest(server, { lang });
      servers.push(server);
    }
    const dev = item.type === 'request' && isDevToolRequest(item.browser?.path);
    const previous = timeline.at(-1);
    if (dev && previous?.type === 'dev-group') previous.items.push(item);
    else if (dev) timeline.push({ type: 'dev-group', items: [item] });
    else timeline.push(item);
  }
  for (const item of timeline) if (item.type === 'dev-group') item.sentence = t.devTools(item.items.length);
  // One line: what was pressed, what the server was asked, what it changed.
  const trigger = dossier.timeline.find(item => item.type === 'trigger')?.trigger;
  const a = t.action;
  const opening = !trigger ? a.continuation : trigger.event === 'submit' ? a.submit(dossier.label) : trigger.event === 'change' ? a.change(dossier.label) : a.click(dossier.label);
  const requests = timeline.filter(item => item.type === 'request' && item.browser?.sameOrigin).map(item => a.request(item.browser.method, item.browser.path, item.browser.status));
  const navigations = timeline.filter(item => item.type === 'navigation' || item.type === 'document').map(item => a.navigates(item.path ?? item.page?.path));
  const screens = dossier.timeline.filter(item => item.type === 'screen');
  const changed = screens.some(item => { const s = item.screen ?? {}; return s.added || s.removed || s.text || s.attributes || s.title || s.stateChanged?.length; });
  const all = effects(servers, lang, { cookies: servers.flatMap(server => server.request?.cookies ?? []) });
  const summary = [opening, requests.length ? requests.join(', ') : a.noServer, ...new Set(navigations), changed ? a.screen : a.noScreen].join(' → ');
  return { timeline, summary, effects: all, lines: servers.reduce((total, server) => total + server.digest.lines.visible, 0) };
}
