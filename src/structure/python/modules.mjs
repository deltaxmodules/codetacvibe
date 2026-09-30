// Python modules of a project (phase 11, step 2): from the facts of
// extract.py, the imports between project files, the symbols of each file
// (with the key of the Python capture) and the project functions each symbol
// calls by name. Built like the Node reader's modules (node/modules.mjs), so
// the edges and the symbol nodes are made the same way.
import { posix } from 'node:path';

// Folder of the Python part a file belongs to ('' for the root): the longest
// folder of `folders` that contains it.
function partOf(path, folders) {
  let found = '';
  for (const folder of folders) if (folder && path.startsWith(`${folder}/`) && folder.length > found.length) found = folder;
  return found;
}

const join = (...parts) => posix.join(...parts.filter(part => part !== '' && part != null));

// The file of a module name, looked up from a base folder: a/b → a/b.py or a/b/__init__.py.
function moduleFile(known, base, dotted) {
  const path = dotted ? join(base, ...dotted.split('.')) : base;
  if (dotted && known.has(`${path}.py`)) return `${path}.py`;
  const init = path ? `${path}/__init__.py` : '__init__.py';
  return known.has(init) ? init : null;
}

// The bases absolute imports are resolved from: the folder of the Python part
// (the root, or api/ in a frontend + API project), then the folder of the
// file itself (a script run directly has its own folder on sys.path).
function resolver(known, folders) {
  return (path, entry) => {
    const here = posix.dirname(path) === '.' ? '' : posix.dirname(path);
    let bases;
    if (entry.level) {
      let base = here;
      for (let step = 1; step < entry.level; step++) base = base.includes('/') ? posix.dirname(base) : '';
      bases = [base];
    } else bases = [...new Set([partOf(path, folders), here])];
    for (const base of bases) {
      const module = moduleFile(known, base, entry.module);
      // from pkg import name: a submodule when pkg/name.py exists, else a name of pkg.
      if (entry.names) {
        const pkg = entry.module ? join(base, ...entry.module.split('.')) : base;
        const found = entry.names.map(({ name, as }) => {
          const submodule = name === '*' ? null : moduleFile(known, pkg, name);
          return submodule ? { target: submodule, names: ['*'], local: as ?? name, module: true } : module ? { target: module, names: [name], local: as ?? name, name } : null;
        });
        if (found.some(Boolean)) return found.filter(Boolean);
      } else if (module) {
        // import a.b binds a (the top package); import a.b as x binds x to a.b.
        return [{ target: module, names: ['*'], local: entry.as ?? entry.module, module: true, dotted: !entry.as }];
      }
    }
    return [];
  };
}

const isCall = value => value?.t === 'call';

// Symbols of one file: top-level functions and classes, methods of classes
// (Class.method), module-level names bound to a call. Handlers nested in a
// function are added by the routes (step 3).
function fileSymbols(facts) {
  const symbols = [];
  const seen = new Set();
  const add = symbol => { if (!seen.has(symbol.name)) { seen.add(symbol.name); symbols.push(symbol); } };
  const classes = new Set(facts.definitions.filter(item => item.kind === 'class').map(item => item.qualname));
  for (const item of facts.definitions) {
    const parent = item.qualname.includes('.') ? item.qualname.slice(0, item.qualname.lastIndexOf('.')) : null;
    if (!parent && (item.kind === 'function' || item.kind === 'class')) {
      add({ name: item.qualname, kind: item.kind, line: item.line, endLine: item.endLine, exported: !item.name.startsWith('_') });
    } else if (item.kind === 'method' && parent.split('.').every((_, index, parts) => classes.has(parts.slice(0, index + 1).join('.')))) {
      add({ name: item.qualname, kind: 'method', line: item.line, endLine: item.endLine, exported: false });
    }
  }
  for (const item of facts.assignments) {
    const target = item.targets.length === 1 ? item.targets[0] : null;
    if (item.scope || target?.t !== 'name' || target.v.includes('.') || !isCall(item.value)) continue;
    add({ name: target.v, kind: 'variable', line: item.line, exported: !target.v.startsWith('_') });
  }
  return symbols.sort((a, b) => a.line - b.line);
}

// The symbol a scope belongs to: the longest prefix of its qualified name
// that is a symbol (what a nested function does is its parent's doing).
export function ownerOf(scope, names) {
  if (!scope) return null;
  const parts = scope.split('.');
  for (let length = parts.length; length > 0; length--) {
    const name = parts.slice(0, length).join('.');
    if (names.has(name)) return name;
  }
  return null;
}

// Returns Map(path → { imports: [{ target, names, line }], symbols: [...],
// bindings: Map(local name → { target, name?, module? }), calls: [{ owner, target: { path, name }, line }], error }).
export function pythonModules(files, facts, { folders = [''] } = {}) {
  const known = new Set(files.map(file => file.path));
  const resolve = resolver(known, folders);
  const modules = new Map();
  for (const file of files) {
    const item = facts.get(file.path);
    if (!item || item.error) { modules.set(file.path, { imports: [], symbols: [], bindings: new Map(), calls: [], error: item?.error ?? null }); continue; }
    const imports = [];
    const bindings = new Map();
    for (const entry of item.imports) {
      for (const found of resolve(file.path, entry)) {
        imports.push({ target: found.target, names: found.names, line: entry.line });
        // Only module-level imports bind names for the whole file; the others
        // still count as imports, and bind inside their function too.
        const local = found.dotted ? found.local.split('.')[0] : found.local;
        if (found.dotted && found.local.includes('.')) continue;
        bindings.set(local, { target: found.target, ...(found.module ? { module: true } : { name: found.name }) });
      }
    }
    modules.set(file.path, { imports, symbols: fileSymbols(item), bindings, calls: [], error: null, facts: item });
  }
  // Calls by name: f() to a function of the same file or imported from the
  // project (from m import f), m.f() through an imported module.
  const symbolIn = (path, name) => modules.get(path)?.symbols.find(symbol => symbol.name === name && symbol.kind !== 'variable') ?? null;
  for (const [path, module] of modules) {
    if (!module.facts) continue;
    const names = new Set(module.symbols.filter(symbol => symbol.kind !== 'variable').map(symbol => symbol.name));
    for (const call of module.facts.calls) {
      if (call.func?.t !== 'name') continue;
      const [head, ...rest] = call.func.v.split('.');
      let target = null;
      if (!rest.length) {
        const local = symbolIn(path, head);
        const bound = module.bindings.get(head);
        if (local && local.kind === 'function') target = { path, name: head };
        else if (bound && !bound.module && symbolIn(bound.target, bound.name)?.kind === 'function') target = { path: bound.target, name: bound.name };
      } else if (rest.length === 1) {
        const bound = module.bindings.get(head);
        if (bound?.module && symbolIn(bound.target, rest[0])?.kind === 'function') target = { path: bound.target, name: rest[0] };
      }
      if (target) module.calls.push({ scope: call.scope, owner: ownerOf(call.scope, names), target, line: call.line });
    }
    delete module.facts;
  }
  return modules;
}
