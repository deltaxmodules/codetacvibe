// Structural smells (phase 8): organisation problems AI-generated code tends
// to pile up. Informative only: nothing blocks. Computed from the graph (and,
// for duplication and the package.json scripts, from the project's files)
// when the view asks; nothing is stored in the graph.
//
//   large-file       a code file longer than the limit
//   cycle            files that import each other, directly or round a loop
//   dead-file        a code file nothing imports and no framework or script
//                    starts ("possibly" when a module chosen at run time, or
//                    the file's place, leaves room for doubt)
//   unused-export    an export no file of the project imports
//   duplicate        two stretches of code almost the same (tokens compared)
//   coupling         a block every other block depends on, or that depends on
//                    all the others; a file too many files import, or that
//                    imports too many
//   skipped-layer    browser Interface code talking straight to Data access or
//                    External integrations while the project has its own
//                    server routes to go through
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { declaredCommands } from '../detect-python.mjs';

export const SMELL_KINDS = ['cycle', 'skipped-layer', 'coupling', 'duplicate', 'dead-file', 'large-file', 'unused-export'];
export const DEFAULT_THRESHOLDS = { largeFileLines: 400, duplicateTokens: 80, duplicateLines: 8, couplingFiles: 25, couplingBlocks: 4 };
const CODE = new Set(['js', 'jsx', 'ts', 'tsx', 'python']);
const CODE_BLOCKS = new Set(['block:interface', 'block:routes', 'block:logic', 'block:data', 'block:external', 'block:utilities']);
const NOT_DEAD_BLOCKS = new Set(['block:config', 'block:tests']);
const byProof = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);

// Files a framework, a runner or the package.json starts without importing
// them (phase 8, step 2). Returns { sure: Set, possible: Map(path → reason) }.
const NEXT_APP = /^(?:src\/)?app\/(?:.*\/)?(?:page|layout|template|loading|error|global-error|not-found|default|route|opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest)\.(?:[jt]sx?|mjs)$/;
const NEXT_ROOT = /^(?:src\/)?(?:middleware|instrumentation|instrumentation-client)\.(?:[jt]s|mjs)$/;
const NEXT_PAGES = /^(?:src\/)?pages\/.+\.(?:[jt]sx?|mjs)$/;
const TEST_FILE = /(?:^|\/)(?:__tests__|__mocks__|tests?|e2e|cypress|playwright)\/|\.(?:test|spec|stories|story)\.[cm]?[jt]sx?$|(?:^|\/)(?:test_[^/]*|[^/]*_test|conftest)\.py$/;
const CONFIG_FILE = /(?:^|\/)[\w.-]+\.config\.[cm]?[jt]s$|(?:^|\/)\.?[\w-]+rc\.[cm]?js$/;
const CONVENTION_FOLDER = /(?:^|\/)(?:pages|routes|api|functions|workers?|scripts|bin|cli|commands|plugins|migrations|seeds?|jobs|cron)\//;
// Served as they are and loaded by their address (a service worker, a worklet).
const PUBLIC_FOLDER = /^(?:.*\/)?(?:public|static)\//;
const ENTRY_NAME = /(?:^|\/)(?:index|main|server|app|worker|cli|handler|lambda)\.(?:[cm]?[jt]sx?|py)$/;
// Python files a runner starts or Python runs without an import (phase 11):
// package inits, `python -m pkg`, Django's manage.py, WSGI/ASGI entries, and
// the Alembic migrations.
const PYTHON_ENTRY = /(?:^|\/)(?:__init__|__main__|manage|wsgi|asgi)\.py$|(?:^|\/)(?:migrations|alembic)\/.*\.py$/;

function packageEntries(root, graph) {
  const files = new Set(graph.nodes.filter(node => node.kind === 'file').map(node => node.path));
  const found = new Set();
  for (const manifest of [...files].filter(path => path === 'package.json' || path.endsWith('/package.json'))) {
    let pkg;
    try { pkg = JSON.parse(readFileSync(join(root, manifest), 'utf8')); } catch { continue; }
    const folder = posix.dirname(manifest) === '.' ? '' : `${posix.dirname(manifest)}/`;
    const add = value => {
      if (typeof value !== 'string') return;
      const path = posix.normalize(folder + value.replace(/^\.\//, ''));
      for (const candidate of [path, `${path}.js`, `${path}.ts`, `${path}.mjs`, `${path}/index.js`, `${path}/index.ts`]) if (files.has(candidate)) found.add(candidate);
    };
    add(pkg.main); add(pkg.module); add(pkg.browser);
    for (const value of typeof pkg.bin === 'object' && pkg.bin ? Object.values(pkg.bin) : [pkg.bin]) add(value);
    const exported = value => { if (typeof value === 'string') add(value); else if (value && typeof value === 'object') Object.values(value).forEach(exported); };
    exported(pkg.exports);
    for (const script of Object.values(pkg.scripts ?? {})) {
      if (typeof script !== 'string') continue;
      for (const word of script.split(/[\s;&|=()'"]+/)) if (/\.[cm]?[jt]sx?$/.test(word)) add(word);
    }
  }
  return found;
}

// Python files started by a declared command (uvicorn app.main:app, python
// run.py, in a Procfile, pyproject.toml, Makefile, README or package.json
// script) or that run themselves (if __name__ == '__main__').
function pythonEntries(root, graph) {
  const files = new Set(graph.nodes.filter(node => node.kind === 'file').map(node => node.path));
  const found = new Set();
  const folders = new Set(['', ...[...files].filter(path => /(?:^|\/)(?:requirements[^/]*\.txt|pyproject\.toml|Procfile)$/.test(path)).map(path => posix.dirname(path) === '.' ? '' : posix.dirname(path))]);
  const add = (folder, command) => {
    const base = folder ? `${folder}/` : '';
    const inside = command.match(/\bcd\s+([\w./-]+)\s*&&/)?.[1];
    const from = inside ? `${posix.normalize(base + inside)}/`.replace(/^\.\//, '') : base;
    for (const match of command.matchAll(/(?:uvicorn|gunicorn|hypercorn|granian)\s+(?:[^\s]*\s+)*?([\w.]+):\w+/g)) {
      const module = from + match[1].split('.').join('/');
      for (const candidate of [`${module}.py`, `${module}/__init__.py`]) if (files.has(candidate)) found.add(candidate);
    }
    for (const match of command.matchAll(/python3?\s+(?:-\S+\s+)*([\w./-]+\.py)\b/g)) if (files.has(posix.normalize(from + match[1]))) found.add(posix.normalize(from + match[1]));
    for (const match of command.matchAll(/--app[= ]([\w.]+)/g)) {
      const module = from + match[1].split('.').join('/');
      if (files.has(`${module}.py`)) found.add(`${module}.py`);
    }
  };
  for (const folder of folders) for (const { command } of declaredCommands(join(root, folder))) add(folder, command);
  for (const manifest of [...files].filter(path => path === 'package.json' || path.endsWith('/package.json'))) {
    try { for (const script of Object.values(JSON.parse(readFileSync(join(root, manifest), 'utf8')).scripts ?? {})) if (typeof script === 'string') add(posix.dirname(manifest) === '.' ? '' : posix.dirname(manifest), script); } catch {}
  }
  for (const path of files) {
    if (!path.endsWith('.py')) continue;
    try { if (/^if\s+__name__\s*==\s*['"]__main__['"]\s*:/m.test(readFileSync(join(root, path), 'utf8'))) found.add(path); } catch {}
  }
  return found;
}

export function entryFiles(graph, root) {
  const sure = new Set(root ? [...packageEntries(root, graph), ...pythonEntries(root, graph)] : []);
  const possible = new Map();
  const next = (graph.project?.types ?? []).some(type => type.startsWith('next'));
  const exposes = new Set(graph.edges.filter(edge => edge.kind === 'exposes').map(edge => edge.from.slice(5)));
  for (const node of graph.nodes.filter(item => item.kind === 'file')) {
    const path = node.path;
    if (NOT_DEAD_BLOCKS.has(node.block) || TEST_FILE.test(path) || CONFIG_FILE.test(path) || exposes.has(path) || path.endsWith('.d.ts') || PYTHON_ENTRY.test(path)) sure.add(path);
    else if (next && (NEXT_APP.test(path) || NEXT_ROOT.test(path) || NEXT_PAGES.test(path))) sure.add(path);
    else if (PUBLIC_FOLDER.test(path)) possible.set(path, 'public');
    else if (CONVENTION_FOLDER.test(`/${path}`)) possible.set(path, 'folder');
    else if (ENTRY_NAME.test(`/${path}`)) possible.set(path, 'name');
  }
  // A module chosen at run time can be any file of its folder. One whose path
  // has no fixed folder (import(url), a temporary file, a package name) says
  // nothing about the project's files and leaves them as they are (M141).
  for (const note of (graph.notes ?? []).filter(item => item.kind === 'dynamic-import' && item.path !== undefined)) {
    for (const node of graph.nodes.filter(item => item.kind === 'file' && CODE.has(item.language))) {
      if (!sure.has(node.path) && node.path.startsWith(note.path)) possible.set(node.path, { note });
    }
  }
  return { sure, possible };
}

// Loops of imports between files (Tarjan's strongly connected components).
export function importCycles(graph) {
  const next = new Map();
  for (const edge of graph.edges) {
    if (edge.kind !== 'imports' || !edge.from.startsWith('file:') || !edge.to.startsWith('file:') || edge.from === edge.to) continue;
    if (!next.has(edge.from)) next.set(edge.from, []);
    next.get(edge.from).push(edge);
  }
  let index = 0;
  const order = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const groups = [];
  const visit = start => {
    // Iterative, so a long chain of imports cannot overflow the stack.
    const work = [[start, 0]];
    order.set(start, index); low.set(start, index); index++; stack.push(start); onStack.add(start);
    while (work.length) {
      const [node, position] = work[work.length - 1];
      const edges = next.get(node) ?? [];
      if (position < edges.length) {
        work[work.length - 1][1]++;
        const target = edges[position].to;
        if (!order.has(target)) { order.set(target, index); low.set(target, index); index++; stack.push(target); onStack.add(target); work.push([target, 0]); }
        else if (onStack.has(target)) low.set(node, Math.min(low.get(node), order.get(target)));
        continue;
      }
      work.pop();
      if (work.length) { const parent = work[work.length - 1][0]; low.set(parent, Math.min(low.get(parent), low.get(node))); }
      if (low.get(node) === order.get(node)) {
        const group = [];
        let item;
        do { item = stack.pop(); onStack.delete(item); group.push(item); } while (item !== node);
        if (group.length > 1) groups.push(group);
      }
    }
  };
  for (const node of [...next.keys()].sort()) if (!order.has(node)) visit(node);
  return groups.map(group => {
    const members = new Set(group);
    const edges = group.flatMap(id => (next.get(id) ?? []).filter(edge => members.has(edge.to)));
    return { files: group.map(id => id.slice(5)).sort(), proof: edges.flatMap(edge => edge.proof).sort(byProof) };
  }).sort((a, b) => (a.files[0] < b.files[0] ? -1 : 1));
}

// Tokens of a code file: comments dropped, strings and numbers alike (so two
// copies that differ only in a text or a number still match). Cached by hash.
const tokenCache = new Map();
const PYTHON_TOKENS = /#[^\n]*|('''[\s\S]*?'''|"""[\s\S]*?"""|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")|(\b\d[\d_.]*(?:e[+-]?\d+)?j?\b)|([A-Za-z_][\w]*)|(->|==|!=|<=|>=|\*\*|\/\/|:=|[{}()[\];,.<>+\-*/%=!?:&|^~@])/g;
export function tokens(text, { python = false } = {}) {
  const list = [];
  const pattern = python ? PYTHON_TOKENS : /\/\/[^\n]*|\/\*[\s\S]*?\*\/|(`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")|(\b\d[\d_.]*(?:e[+-]?\d+)?n?\b)|([A-Za-z_$][\w$]*)|(=>|===|!==|==|!=|<=|>=|&&|\|\||\?\?|\?\.|\.\.\.|[{}()[\];,.<>+\-*/%=!?:&|^~@#])/g;
  let line = 1;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    line += (text.slice(last, match.index).match(/\n/g) ?? []).length;
    last = match.index;
    if (match[1] !== undefined) list.push(['"s"', line]);
    else if (match[2] !== undefined) list.push(['0', line]);
    else if (match[3] !== undefined) list.push([match[3], line]);
    else if (match[4] !== undefined) list.push([match[4], line]);
    line += (match[0].match(/\n/g) ?? []).length;
    last = match.index + match[0].length;
  }
  return list;
}

// Stretches of at least `minTokens` equal tokens found in two places or more
// (files, or two places of one file). One result per stretch, with all its
// places. Windows of tokens are found by a rolling hash over token numbers,
// and every match is checked token by token.
export function duplicates(sources, { minTokens = DEFAULT_THRESHOLDS.duplicateTokens, minLines = DEFAULT_THRESHOLDS.duplicateLines } = {}) {
  const numbers = new Map();
  const lists = sources.map(source => Int32Array.from(source.tokens, ([token]) => { if (!numbers.has(token)) numbers.set(token, numbers.size + 1); return numbers.get(token); }));
  const BASE = 1000003;
  let power = 1;
  for (let step = 1; step < minTokens; step++) power = Math.imul(power, BASE);
  const windows = new Map();
  lists.forEach((list, file) => {
    if (list.length < minTokens) return;
    let hash = 0;
    for (let index = 0; index < list.length; index++) {
      if (index >= minTokens) hash = (hash - Math.imul(list[index - minTokens], power)) | 0;
      hash = (Math.imul(hash, BASE) + list[index]) | 0;
      if (index < minTokens - 1) continue;
      const start = index - minTokens + 1;
      const places = windows.get(hash);
      if (places) places.push(file, start); else windows.set(hash, [file, start]);
    }
  });
  const same = (a, b, length) => { for (let offset = 0; offset < length; offset++) if (lists[a[0]][a[1] + offset] !== lists[b[0]][b[1] + offset]) return false; return true; };
  const covered = new Set();
  const found = [];
  for (const flat of windows.values()) {
    if (flat.length < 4) continue;
    let places = [];
    for (let index = 0; index < flat.length; index += 2) {
      const place = [flat[index], flat[index + 1]];
      if (covered.has(`${place[0]}:${place[1]}`)) continue;
      // Two places of one file must not overlap.
      if (places.some(other => other[0] === place[0] && Math.abs(other[1] - place[1]) < minTokens)) continue;
      if (!places.length || same(places[0], place, minTokens)) places.push(place);
    }
    if (places.length < 2) continue;
    let length = minTokens;
    const grows = () => places.every(([file, start]) => start + length < lists[file].length && lists[file][start + length] === lists[places[0][0]][places[0][1] + length]
      && !places.some(([other, from]) => other === file && from > start && start + length >= from));
    while (grows()) length++;
    for (const [file, start] of places) for (let step = 0; step <= length - minTokens; step++) covered.add(`${file}:${start + step}`);
    // A list of alike lines (app.use(…) for every route) repeats itself: not a copy.
    const [file, start] = places[0];
    const periodic = period => { for (let offset = 0; offset + period < length; offset++) if (lists[file][start + offset] !== lists[file][start + offset + period]) return false; return true; };
    let repeats = false;
    for (let period = 1; period <= length / 2 && !repeats; period++) repeats = periodic(period);
    if (repeats) continue;
    const ranges = places.map(([file, start]) => ({ file: sources[file].path, line: sources[file].tokens[start][1], endLine: sources[file].tokens[start + length - 1][1] }));
    if (ranges.some(range => range.endLine - range.line + 1 < minLines)) continue;
    found.push({ tokens: length, places: ranges.sort(byProof) });
  }
  return found.sort((x, y) => y.places.length * y.tokens - x.places.length * x.tokens || byProof(x.places[0], y.places[0]));
}

function sourcesOf(graph, root) {
  const files = graph.nodes.filter(node => node.kind === 'file' && CODE.has(node.language) && !NOT_DEAD_BLOCKS.has(node.block) && !node.path.endsWith('.d.ts') && node.size <= 200_000);
  return files.map(node => {
    let list = tokenCache.get(node.hash);
    if (!list) {
      try { list = tokens(readFileSync(join(root, node.path), 'utf8'), { python: node.language === 'python' }); } catch { list = []; }
      tokenCache.set(node.hash, list);
    }
    return { path: node.path, tokens: list };
  });
}

// Every smell of a project, most important first. thresholds come from
// codetac.structure.json ("smells"), over the defaults; smells.off turns kinds off.
export function structureSmells(graph, { root = null, thresholds = {} } = {}) {
  const limits = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const files = graph.nodes.filter(node => node.kind === 'file');
  const code = files.filter(node => CODE.has(node.language));
  const imports = graph.edges.filter(edge => edge.kind === 'imports' && edge.from.startsWith('file:') && edge.to.startsWith('file:'));
  const importersOf = new Map();
  for (const edge of imports) { if (!importersOf.has(edge.to)) importersOf.set(edge.to, []); importersOf.get(edge.to).push(edge); }
  const smells = [];

  for (const cycle of importCycles(graph)) {
    smells.push({ kind: 'cycle', certainty: 'sure', files: cycle.files, box: nodes.get(`file:${cycle.files[0]}`)?.block ?? null, proof: cycle.proof });
  }

  const entries = entryFiles(graph, root);
  const dead = new Set();
  for (const file of code) {
    if ((importersOf.get(file.id) ?? []).length || entries.sure.has(file.path)) continue;
    const doubt = entries.possible.get(file.path);
    dead.add(file.path);
    smells.push({ kind: 'dead-file', certainty: doubt ? 'possible' : 'sure', files: [file.path], box: file.block,
      ...(doubt?.note ? { because: doubt.note.message } : doubt ? { because: doubt } : {}), proof: [{ file: file.path, line: 1 }, ...(doubt?.note?.proof ?? [])] });
  }

  // Exports nobody imports, in files that are imported (a dead file is one
  // smell, not one per export) and are not entries (a page's default export
  // is for the framework).
  for (const file of code) {
    if (dead.has(file.path) || entries.sure.has(file.path) || entries.possible.has(file.path)) continue;
    const taken = new Set((importersOf.get(file.id) ?? []).flatMap(edge => edge.names ?? ['*']));
    if (taken.has('*')) continue;
    // In Python a public module-level object (engine = create_engine(…)) is
    // wiring, not an export: only functions and classes count there.
    for (const symbol of graph.nodes.filter(node => node.kind === 'symbol' && node.file === file.id && node.exported && !(file.language === 'python' && node.symbolKind === 'variable'))) {
      if ([symbol.name, ...(symbol.exportedAs ?? [])].some(name => taken.has(name))) continue;
      smells.push({ kind: 'unused-export', certainty: 'sure', files: [file.path], name: symbol.name, box: file.block, proof: [{ file: file.path, line: symbol.line }] });
    }
  }

  for (const file of code) {
    if (file.lines > limits.largeFileLines && !NOT_DEAD_BLOCKS.has(file.block)) {
      smells.push({ kind: 'large-file', certainty: 'sure', files: [file.path], lines: file.lines, limit: limits.largeFileLines, box: file.block, proof: [{ file: file.path, line: 1 }] });
    }
  }

  // Coupling between blocks (code blocks only), then between files.
  const blocks = [...new Set(code.map(file => file.block))].filter(block => CODE_BLOCKS.has(block));
  const dependsOn = new Map(blocks.map(block => [block, new Map()]));
  for (const edge of imports) {
    const from = nodes.get(edge.from)?.block;
    const to = nodes.get(edge.to)?.block;
    if (from === to || !dependsOn.has(from) || !dependsOn.has(to)) continue;
    if (!dependsOn.get(from).has(to)) dependsOn.get(from).set(to, edge.proof[0]);
  }
  if (blocks.length - 1 >= limits.couplingBlocks) {
    for (const block of blocks) {
      const others = blocks.filter(item => item !== block);
      const out = dependsOn.get(block);
      const into = others.filter(other => dependsOn.get(other).has(block));
      if (others.every(other => out.has(other))) smells.push({ kind: 'coupling', certainty: 'sure', direction: 'uses-all', block, box: block, proof: [...out.values()].sort(byProof) });
      if (into.length === others.length) smells.push({ kind: 'coupling', certainty: 'sure', direction: 'used-by-all', block, box: block, proof: into.map(other => dependsOn.get(other).get(block)).sort(byProof) });
    }
  }
  const importsOf = new Map();
  for (const edge of imports) { if (!importsOf.has(edge.from)) importsOf.set(edge.from, []); importsOf.get(edge.from).push(edge); }
  for (const file of code) {
    const into = importersOf.get(file.id) ?? [];
    const out = importsOf.get(file.id) ?? [];
    if (into.length >= limits.couplingFiles) smells.push({ kind: 'coupling', certainty: 'sure', direction: 'file-used-by-many', files: [file.path], count: into.length, box: file.block, proof: into.map(edge => edge.proof[0]).sort(byProof).slice(0, 12) });
    if (out.length >= limits.couplingFiles) smells.push({ kind: 'coupling', certainty: 'sure', direction: 'file-uses-many', files: [file.path], count: out.length, box: file.block, proof: out.map(edge => edge.proof[0]).sort(byProof).slice(0, 12) });
  }

  // Browser Interface straight to Data access or External integrations, when
  // the project has server routes of its own to go through.
  if (files.some(file => file.block === 'block:routes')) {
    for (const edge of imports) {
      const from = nodes.get(edge.from);
      const to = nodes.get(edge.to);
      if (from?.block !== 'block:interface' || !['client', 'both'].includes(from.runsOn) || !['block:data', 'block:external'].includes(to?.block)) continue;
      smells.push({ kind: 'skipped-layer', certainty: 'sure', files: [from.path, to.path], to: to.block, box: from.block, proof: edge.proof });
    }
  }

  // Duplication: the stretches shared by the same files are one smell.
  if (root) {
    const bySet = new Map();
    for (const item of duplicates(sourcesOf(graph, root), { minTokens: limits.duplicateTokens, minLines: limits.duplicateLines })) {
      const files = [...new Set(item.places.map(place => place.file))];
      const key = files.join('\n');
      if (!bySet.has(key)) bySet.set(key, { files, stretches: 0, tokens: 0, places: 0, proof: [] });
      const group = bySet.get(key);
      group.stretches += 1;
      group.tokens += item.tokens;
      group.places = Math.max(group.places, item.places.length);
      group.proof.push(...item.places);
    }
    for (const group of bySet.values()) {
      smells.push({ kind: 'duplicate', certainty: 'sure', files: group.files, tokens: group.tokens, places: group.places, stretches: group.stretches,
        box: nodes.get(`file:${group.files[0]}`)?.block ?? null, proof: group.proof.sort(byProof).slice(0, 12) });
    }
  }

  const off = new Set(thresholds.off ?? []);
  return smells.filter(item => !off.has(item.kind)).sort((a, b) => SMELL_KINDS.indexOf(a.kind) - SMELL_KINDS.indexOf(b.kind)
    || (b.tokens ?? 0) * (b.places ?? 1) - (a.tokens ?? 0) * (a.places ?? 1) || (b.lines ?? 0) - (a.lines ?? 0) || (a.certainty === b.certainty ? 0 : a.certainty === 'sure' ? -1 : 1)
    || byProof(a.proof[0], b.proof[0]));
}

// The «Structure health» view (phase 8, step 4): the smells in order, each
// with where it opens in the plan (the block, and the file inside it).
export function healthView(graph, options = {}) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const smells = structureSmells(graph, options).map(item => {
    const file = item.files?.length ? nodes.get(`file:${item.files[0]}`) : null;
    const block = file?.block ?? item.block ?? item.box ?? null;
    return { ...item, blockName: nodes.get(block)?.name ?? null, target: file ? { id: file.id, open: [block] } : block ? { id: block, open: [] } : null };
  });
  const byKind = {};
  for (const item of smells) byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
  return { smells, summary: { total: smells.length, possible: smells.filter(item => item.certainty === 'possible').length, byKind } };
}
