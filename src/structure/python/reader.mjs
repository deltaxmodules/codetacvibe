// The Python reader of StructureTAC (phase 11): turns the Python part of a
// project into the graph of graph.schema.json, like the Node reader.
// Registered in readers.mjs.
//
// Where it runs (decision of phase 11): a small helper, extract.py, standard
// library only, is run once per reading with the project's interpreter for the
// .py files that changed; it returns the facts of their syntax (ast) as JSON.
// The graph is built here, on the Node side. Facts are cached by file hash,
// outside the project; when nothing changed, Python is not even started. With
// no Python 3.8 or later on the machine, the files are listed but not read,
// and a note says why.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirectory } from '../../home.mjs';
import { hasPythonSignals } from '../../detect-python.mjs';
import { inventory, SKIPPED_FOLDERS } from '../node/inventory.mjs';
import { literalKeys, maskKeys } from '../node/modules.mjs';
import { environment, literalKeyNotes } from '../node/env.mjs';
import { outgoingServices } from '../node/outgoing.mjs';
import { serviceCatalogue } from '../services.mjs';
import { pythonCatalogue, pythonUsage } from './outgoing.mjs';
import { readConfig } from '../config.mjs';
import { blockEdges, importEdges } from '../node/edges.mjs';
import { applyUserLayers } from '../layers.mjs';
import { classifyPython } from './classify.mjs';
import { pythonModules } from './modules.mjs';
import { pythonRoutes } from './routes.mjs';
import { pythonDataModel, pythonStore, pythonTableGraph } from './datamodel.mjs';
import { t } from '../text.mjs';

const EXTRACT = fileURLToPath(new URL('./extract.py', import.meta.url));
const MINIMUM = [3, 8];
const ENVIRONMENTS = ['.venv', 'venv', 'env'];
const CACHE_VERSION = 1;
const FRAMEWORKS = [['fastapi', 'fastapi'], ['flask', 'flask']];

const isFolder = path => { try { return statSync(path).isDirectory(); } catch { return false; } };
const readText = (path, limit = 200_000) => { try { return readFileSync(path, 'utf8').slice(0, limit); } catch { return ''; } };

// Folders with a Python part: the root and its first-level folders (a
// frontend at the root with the API in api/ or backend/ is common).
export function pythonFolders(root) {
  const folders = [];
  const rootFiles = (() => { try { return readdirSync(root); } catch { return []; } })();
  if (hasPythonSignals(root) || rootFiles.some(name => name.endsWith('.py'))) folders.push('');
  for (const name of rootFiles.sort()) {
    if (name.startsWith('.') || SKIPPED_FOLDERS.has(name) || ENVIRONMENTS.includes(name)) continue;
    const path = join(root, name);
    if (isFolder(path) && !existsSync(join(path, 'pyvenv.cfg')) && hasPythonSignals(path)) folders.push(name);
  }
  return folders;
}

// Project types from the declared dependencies of each Python part and from
// what the code imports.
// What the Python parts declare they depend on (lower case).
function declaredText(root, folders) {
  return folders.map(folder => ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py', 'setup.cfg']
    .map(name => readText(join(root, folder, name))).join('\n').toLowerCase()).join('\n');
}

function projectTypes(root, folders, facts) {
  const declared = declaredText(root, folders);
  const imported = new Set();
  for (const item of facts.values()) for (const entry of item.imports ?? []) if (!entry.level) imported.add(entry.module.split('.')[0]);
  return FRAMEWORKS.filter(([name]) => imported.has(name) || new RegExp(`(^|[\\s"'\\[,])${name}(?![\\w-])`, 'm').test(declared)).map(([, type]) => type);
}

const interpreterCache = new Map();
function version(interpreter) {
  const result = spawnSync(interpreter, ['-I', '-S', '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0) return null;
  const [major, minor] = result.stdout.trim().split('.').map(Number);
  return major > MINIMUM[0] || (major === MINIMUM[0] && minor >= MINIMUM[1]) ? `${major}.${minor}` : null;
}

// The interpreter that reads the files: CODETAC_PYTHON when set (only that
// one), else a virtual environment of a Python part, else python3, python.
// Any Python 3.8+ reads the syntax of the project's files; the project's own
// one is preferred because it knows the syntax the project is written in.
export function chooseInterpreter(root, folders, env = process.env) {
  const key = `${root}\0${env.CODETAC_PYTHON ?? ''}`;
  if (interpreterCache.has(key)) return interpreterCache.get(key);
  const bin = environment => (process.platform === 'win32' ? join(environment, 'Scripts', 'python.exe') : join(environment, 'bin', 'python'));
  const candidates = env.CODETAC_PYTHON ? [env.CODETAC_PYTHON] : [
    ...folders.flatMap(folder => ENVIRONMENTS.map(name => join(root, folder, name)).filter(path => existsSync(join(path, 'pyvenv.cfg'))).map(bin)),
    'python3', 'python',
  ];
  let chosen = null;
  for (const candidate of candidates) {
    const found = version(candidate);
    if (found) { chosen = { interpreter: candidate, version: found }; break; }
  }
  interpreterCache.set(key, chosen);
  return chosen;
}

function cachePath(root) {
  return join(dataDirectory(), 'structure', 'cache', `${createHash('sha256').update(root).digest('hex').slice(0, 32)}-python.json`);
}
const extractorHash = () => createHash('sha256').update(readFileSync(EXTRACT)).digest('hex').slice(0, 16);

// Runs extract.py on some files. Keys written in the code are masked before
// the facts go anywhere (the cache included): only their shape is kept.
function extract(root, paths, interpreter) {
  const result = spawnSync(interpreter, ['-I', '-S', EXTRACT], { input: JSON.stringify({ root, files: paths }), encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024, timeout: 300_000, env: { PATH: process.env.PATH ?? '', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' } });
  if (result.status !== 0) throw new Error(`extract.py stopped (${result.error?.code ?? `exit ${result.status}`}): ${String(result.stderr ?? '').trim().split('\n').pop()?.slice(0, 200) ?? ''}`);
  return JSON.parse(maskKeys(result.stdout)).files;
}

// Facts of every .py file: from the cache when the hash is the same, else
// from extract.py. Returns { facts: Map(path → facts), interpreter, problem,
// extracted (how many files went to Python), unread }.
export function pythonFacts(root, files, { cache = true, folders = pythonFolders(root) } = {}) {
  const tool = extractorHash();
  let previous = {};
  if (cache) {
    try {
      const saved = JSON.parse(readFileSync(cachePath(root), 'utf8'));
      if (saved.version === CACHE_VERSION && saved.extractor === tool) previous = saved.files;
    } catch {}
  }
  const facts = new Map();
  const missing = [];
  for (const file of files) {
    if (previous[file.path]?.hash === file.hash) facts.set(file.path, previous[file.path].facts);
    else missing.push(file);
  }
  let interpreter = null;
  let problem = null;
  if (missing.length) {
    interpreter = chooseInterpreter(root, folders);
    if (!interpreter) problem = 'no-python';
    else {
      try {
        const read = extract(root, missing.map(file => file.path), interpreter.interpreter);
        // Keys written in the code (phase 5): their kind and line only, read here from the source.
        for (const file of missing) {
          if (!read[file.path]) continue;
          let keys = [];
          try { keys = literalKeys(readFileSync(join(root, file.path), 'utf8')); } catch {}
          facts.set(file.path, { ...read[file.path], keys });
        }
      } catch (error) { problem = String(error.message ?? error); }
    }
  }
  if (cache && !problem && (missing.length || Object.keys(previous).length !== files.length)) {
    const next = Object.fromEntries(files.filter(file => facts.has(file.path)).map(file => [file.path, { hash: file.hash, facts: facts.get(file.path) }]));
    const path = cachePath(root);
    try {
      mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
      writeFileSync(`${path}.tmp`, JSON.stringify({ version: CACHE_VERSION, extractor: tool, files: next }), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    } catch {}
  }
  return { facts, interpreter, problem, extracted: missing.length, unread: files.filter(file => !facts.has(file.path)).map(file => file.path) };
}

// A symbol node, keyed as the Python capture keys a function: path#Qualified.name@line of the def.
export function symbolNode(path, symbol) {
  const key = `${path}#${symbol.name}@${symbol.line}`;
  return { id: `symbol:${key}`, kind: 'symbol', name: symbol.name, file: `file:${path}`, symbolKind: symbol.kind, line: symbol.line,
    ...(symbol.endLine ? { endLine: symbol.endLine } : {}), exported: symbol.exported, key, origin: 'static', proof: [{ file: path, line: symbol.line }] };
}

export const pythonReader = {
  name: 'python',
  version: '0.1.0',
  languages: ['python'],
  detect(folder) {
    return pythonFolders(folder).length ? { types: [] } : null;
  },
  read(folder, { types = [], cache = true } = {}) {
    const config = readConfig(folder);
    const folders = pythonFolders(folder);
    const { files } = inventory(folder, { cache, ignored: config.ignore.length ? path => config.ignore.some(rule => rule.test(path)) : null });
    const code = files.filter(file => file.language === 'python');
    const { facts, problem, unread } = pythonFacts(folder, code, { cache, folders });
    const notes = [];
    if (problem === 'no-python') {
      notes.push({ kind: 'python-unread', message: t('notes.pythonMissing', { count: unread.length, minimum: MINIMUM.join('.') }) });
    } else if (problem) {
      notes.push({ kind: 'python-unread', message: t('notes.pythonHelperFailed', { count: unread.length, problem }) });
    }
    for (const [path, item] of facts) {
      if (item.error) notes.push({ kind: 'parse-error', message: t('notes.parseError', { path, reason: item.error.message }), proof: [{ file: path, line: item.error.line }] });
    }
    // Files, symbols, imports (steps 1–2), routes (3), blocks (4), data (5),
    // variables and services (6).
    const modules = pythonModules(code, facts, { folders });
    const classes = new Map(classifyPython(files, facts, modules, { folders }).map(item => [item.path, item]));
    notes.unshift(...config.problems.map(message => ({ message })));
    notes.push(...applyUserLayers(folder, files, classes, config));
    const nodes = files.map(file => {
      const { layer, rule, runsOn, suggested } = classes.get(file.path);
      return { id: `file:${file.path}`, kind: 'file', name: basename(file.path), path: file.path, language: file.language, size: file.size, lines: file.lines,
        hash: file.hash, block: `block:${layer}`, rule, ...(runsOn ? { runsOn } : {}),
        ...(suggested ? { origin: 'ai', confidence: 'possible' } : { origin: 'static' }), proof: [{ file: file.path, line: 1 }] };
    });
    for (const [path, module] of modules) for (const symbol of module.symbols) nodes.push(symbolNode(path, symbol));
    const readable = new Map([...facts].filter(([, item]) => !item.error));
    const found = pythonRoutes(modules, readable);
    for (const { path, symbol } of found.handlers) nodes.push(symbolNode(path, symbol));
    notes.push(...found.notes);
    nodes.push(...found.routes);
    // One block per layer present, proved by its first file (paths are sorted).
    for (const layer of [...new Set([...classes.values()].map(item => item.layer))]) {
      const first = files.find(file => classes.get(file.path).layer === layer);
      nodes.push({ id: `block:${layer}`, kind: 'block', name: t(`layers.${layer}`), layer, origin: 'static', proof: [{ file: first.path, line: 1 }] });
    }
    // Symbols and routes belong to the block of their file (a route to the file that exposes it).
    const blockOfNode = new Map(nodes.filter(node => node.kind === 'file').map(node => [node.id, node.block]));
    for (const node of nodes) if (node.kind === 'symbol') blockOfNode.set(node.id, blockOfNode.get(node.file));
    for (const edge of found.edges) if (edge.kind === 'exposes') blockOfNode.set(edge.to, blockOfNode.get(edge.from));
    const fileEdges = [...importEdges(modules), ...found.edges];
    // Tables defined by the models, migrations and SQL of the project, and who reads and writes them (step 5).
    const store = pythonStore(declaredText(folder, folders), readable);
    const data = pythonTableGraph(pythonDataModel(code, readable, { store }), code, readable, modules, { store });
    nodes.push(...data.nodes);
    // Variables, services and keys written in the code (step 6), by the Node reader's functions.
    const catalogue = serviceCatalogue(config.services);
    notes.push(...catalogue.problems.map(message => ({ message })));
    const usage = pythonUsage(code, readable, modules, { catalogue, store });
    const symbolsOf = new Map([...modules].map(([path, module]) => [path, module.symbols]));
    const runsOnOf = new Map([...classes.values()].filter(item => item.runsOn).map(item => [item.path, item.runsOn]));
    const outgoing = outgoingServices(code, usage, { catalogue: pythonCatalogue(catalogue), symbolsOf, runsOn: runsOnOf, skip: path => classes.get(path)?.layer === 'tests' });
    const env = environment(folder, files, usage, { types: [] });
    nodes.push(...outgoing.nodes, ...env.nodes);
    notes.push(...literalKeyNotes(code, usage));
    const edges = [...fileEdges, ...blockEdges(fileEdges, id => blockOfNode.get(id) ?? null), ...data.edges, ...outgoing.edges, ...env.edges];
    return {
      schemaVersion: 1,
      project: { name: basename(folder), types: [...new Set([...types, ...projectTypes(folder, folders, facts)])], languages: ['python'] },
      reader: { name: this.name, version: this.version },
      nodes,
      edges,
      ...(notes.length ? { notes } : {}),
    };
  },
};
