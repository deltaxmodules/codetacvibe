// Routes of a Python project (phase 11, step 3): FastAPI and Flask, read from
// the facts of extract.py. Like node/routes.mjs, it gives the route nodes, the
// file that exposes each one, its handler, and the project functions the
// handler calls (FastAPI's Depends included).
//
// Objects that hold routes: FastAPI() and Flask() apps, APIRouter(prefix=…)
// and Blueprint(…, url_prefix=…), bound to a name in a module or a function
// (an app factory). A router's path is joined from where it is mounted:
// include_router(r, prefix=…) adds to the router's own prefix;
// register_blueprint(bp, url_prefix=…) replaces the blueprint's.
import { ownerOf } from './modules.mjs';
import { t } from '../text.mjs';

const OWNERS = { FastAPI: 'app', APIRouter: 'router', Flask: 'app', Blueprint: 'blueprint' };
const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];
const last = name => name.split('.').pop();
const text = value => (value?.t === 'str' ? value.v : null);

// {id} and {id:path} of FastAPI, <id> and <int:id> of Flask → :id. No
// trailing slash (except the root), one slash between parts.
export function routePath(...parts) {
  const joined = `/${parts.filter(Boolean).join('/')}`.replace(/\/{2,}/g, '/')
    .replace(/\{([A-Za-z_]\w*)(?::[^}]*)?\}/g, ':$1').replace(/<(?:[^:<>]+:)?([A-Za-z_]\w*)>/g, ':$1');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

const parentScope = qualname => (qualname.includes('.') ? qualname.slice(0, qualname.lastIndexOf('.')) : null);

// A value as it is written, for a note (settings.api_prefix, os.environ['P']).
const written = value => value?.t === 'name' ? value.v : value?.t === 'str' ? `'${value.v}'` : value?.t === 'attr' ? `${written(value.of)}.${value.name}`
  : value?.t === 'sub' ? `${written(value.of)}[${written(value.key)}]` : value?.t === 'call' ? `${written(value.func)}(…)` : '…';

// The default of each field of the project's settings classes (BaseSettings,
// also through a class of the project that extends it): field → [{ value, file, line }].
function settingsDefaults(facts) {
  const classes = [];
  for (const [path, item] of facts) {
    for (const definition of item.definitions ?? []) {
      if (definition.kind === 'class') classes.push({ path, item, definition, bases: (definition.bases ?? []).filter(base => base?.t === 'name').map(base => last(base.v)) });
    }
  }
  const settings = new Set(['BaseSettings']);
  for (let grew = true; grew;) {
    grew = false;
    for (const entry of classes) {
      if (!settings.has(entry.definition.name ?? last(entry.definition.qualname)) && entry.bases.some(base => settings.has(base))) {
        settings.add(entry.definition.name ?? last(entry.definition.qualname));
        grew = true;
      }
    }
  }
  const fields = new Map();
  for (const { path, item, definition, bases } of classes) {
    if (!bases.some(base => settings.has(base))) continue;
    for (const assignment of item.assignments ?? []) {
      const name = assignment.scope === definition.qualname && assignment.targets[0]?.t === 'name' ? assignment.targets[0].v : null;
      const value = assignment.value?.t === 'call' && last(assignment.value.func?.v ?? '') === 'Field' ? assignment.value.args[0] ?? assignment.value.kw.default : assignment.value;
      if (!name || value?.t !== 'str') continue;
      if (!fields.has(name)) fields.set(name, []);
      fields.get(name).push({ value: value.v, file: path, line: assignment.line });
    }
  }
  return fields;
}

export function pythonRoutes(modules, facts) {
  // Route holders, per file: { key, path, name, scope, kind, prefix, line }.
  const holders = new Map();
  for (const [path, item] of facts) {
    for (const assignment of item.assignments ?? []) {
      const target = assignment.targets.length === 1 ? assignment.targets[0] : null;
      const value = assignment.value;
      if (target?.t !== 'name' || target.v.includes('.') || value?.t !== 'call' || value.func?.t !== 'name') continue;
      const kind = OWNERS[last(value.func.v)];
      if (!kind) continue;
      const prefix = kind === 'router' ? text(value.kw.prefix) : kind === 'blueprint' ? text(value.kw.url_prefix) : null;
      const key = `${path}:${assignment.scope ?? ''}:${target.v}`;
      holders.set(key, { key, path, name: target.v, scope: assignment.scope, kind, prefix: prefix ?? '', line: assignment.line });
    }
  }
  // The holder a name means in a scope of a file: local first (outwards),
  // then a module-level name, then an import from another project file.
  const holderOf = (path, scope, dotted) => {
    const [head, ...rest] = dotted.split('.');
    if (!rest.length) {
      for (let current = scope; ; current = parentScope(current)) {
        const found = holders.get(`${path}:${current ?? ''}:${head}`);
        if (found) return found;
        if (!current) break;
      }
      const bound = modules.get(path)?.bindings.get(head);
      return bound && !bound.module ? holders.get(`${bound.target}::${bound.name}`) ?? null : null;
    }
    const bound = modules.get(path)?.bindings.get(head);
    return bound?.module && rest.length === 1 ? holders.get(`${bound.target}::${rest[0]}`) ?? null : null;
  };
  // A prefix written as settings.field: the field's default, when the
  // project's settings classes give it only one value.
  const defaults = settingsDefaults(facts);
  const notes = [];
  const prefixOf = (value, at) => {
    if (value == null) return { prefix: null, proof: [] };
    if (value.t === 'str') return { prefix: value.v, proof: [] };
    const field = value.t === 'name' && value.v.includes('.') ? last(value.v) : value.t === 'attr' ? value.name : null;
    const found = field ? defaults.get(field) ?? [] : [];
    if (found.length && new Set(found.map(item => item.value)).size === 1) return { prefix: found[0].value, proof: [{ file: found[0].file, line: found[0].line }] };
    notes.push({ kind: 'route-prefix', message: t('notes.prefixUnread', { prefix: written(value), method: at.method }), proof: [{ file: at.path, line: at.line }] });
    return { prefix: null, proof: [] };
  };
  // Mounts: child holder → [{ parent, prefix, line, path }].
  const mounts = new Map();
  for (const [path, item] of facts) {
    for (const call of item.calls ?? []) {
      const name = call.func?.t === 'name' ? call.func.v : null;
      const method = name && last(name);
      if (method !== 'include_router' && method !== 'register_blueprint') continue;
      const parent = holderOf(path, call.scope, name.slice(0, name.lastIndexOf('.')));
      const child = call.args[0]?.t === 'name' ? holderOf(path, call.scope, call.args[0].v) : null;
      if (!parent || !child) continue;
      const { prefix, proof: from } = prefixOf(call.kw[method === 'include_router' ? 'prefix' : 'url_prefix'], { method, path, line: call.line });
      if (!mounts.has(child.key)) mounts.set(child.key, []);
      mounts.get(child.key).push({ parent, prefix, line: call.line, path, from, replaces: method === 'register_blueprint' });
    }
  }
  // Every full prefix of a holder, with the mount lines that prove it.
  const prefixes = (holder, seen = new Set()) => {
    if (seen.has(holder.key)) return [];
    const own = mounts.get(holder.key);
    if (!own?.length) return [{ prefix: holder.prefix, proof: [] }];
    return own.flatMap(mount => prefixes(mount.parent, new Set([...seen, holder.key])).map(above => ({
      prefix: routePath(above.prefix, mount.prefix ?? '', mount.replaces && mount.prefix != null ? '' : holder.prefix),
      proof: [...above.proof, { file: mount.path, line: mount.line }, ...mount.from],
    })));
  };

  const routes = new Map();
  const edges = new Map();
  const handlers = [];
  const addEdge = (kind, from, to, proof, extra = {}) => {
    const id = `${kind}:${from}->${to}`;
    if (!edges.has(id)) edges.set(id, { id, kind, from, to, origin: 'static', proof: [], ...extra });
    const edge = edges.get(id);
    for (const item of proof) if (!edge.proof.some(known => known.file === item.file && known.line === item.line)) edge.proof.push(item);
  };
  const symbolId = (path, name, line) => `symbol:${path}#${name}@${line}`;
  for (const [path, item] of facts) {
    const module = modules.get(path);
    const symbols = new Map((module?.symbols ?? []).map(symbol => [symbol.name, symbol]));
    for (const definition of item.definitions ?? []) {
      if (definition.kind === 'class') continue;
      for (const decorator of definition.decorators) {
        if (decorator?.t !== 'call' || decorator.func?.t !== 'name' || !decorator.func.v.includes('.')) continue;
        const verb = last(decorator.func.v);
        if (!VERBS.includes(verb) && verb !== 'route' && verb !== 'api_route') continue;
        const holder = holderOf(path, parentScope(definition.qualname), decorator.func.v.slice(0, decorator.func.v.lastIndexOf('.')));
        const own = text(decorator.args[0]) ?? text(decorator.kw.path) ?? text(decorator.kw.rule);
        if (!holder || own == null) continue;
        const listed = decorator.kw.methods?.t === 'list' ? decorator.kw.methods.items.map(text).filter(Boolean).map(value => value.toUpperCase()) : null;
        const methods = VERBS.includes(verb) ? [verb.toUpperCase()] : listed?.length ? listed : ['GET'];
        // The handler: a symbol of the file, or (nested in an app factory) added here.
        let symbol = symbols.get(definition.qualname);
        if (!symbol) {
          symbol = { name: definition.qualname, kind: 'function', line: definition.line, endLine: definition.endLine, exported: false };
          symbols.set(symbol.name, symbol);
          handlers.push({ path, symbol });
        }
        const handler = symbolId(path, symbol.name, symbol.line);
        const at = { file: path, line: decorator.line };
        for (const { prefix, proof } of prefixes(holder)) {
          for (const method of methods) {
            const full = routePath(prefix, own);
            const id = `route:${method} ${full}`;
            if (!routes.has(id)) routes.set(id, { id, kind: 'route', name: `${method} ${full}`, method, path: full, origin: 'static', proof: [] });
            const route = routes.get(id);
            for (const entry of [at, ...proof]) if (!route.proof.some(known => known.file === entry.file && known.line === entry.line)) route.proof.push(entry);
            addEdge('exposes', `file:${path}`, id, [at]);
            addEdge('calls', id, handler, [at]);
          }
        }
        // Handler → the project functions it calls, and its Depends(f).
        const owned = new Set([...symbols.keys()]);
        for (const call of module?.calls ?? []) {
          if (ownerOf(call.scope, owned) !== definition.qualname) continue;
          const target = modules.get(call.target.path)?.symbols.find(candidate => candidate.name === call.target.name);
          if (target) addEdge('calls', handler, symbolId(call.target.path, target.name, target.line), [{ file: path, line: call.line }]);
        }
        for (const value of definition.defaults ?? []) {
          if (value?.t !== 'call' || value.func?.t !== 'name' || last(value.func.v) !== 'Depends' || value.args[0]?.t !== 'name') continue;
          const target = functionOf(modules, path, value.args[0].v);
          if (target) addEdge('calls', handler, symbolId(target.path, target.symbol.name, target.symbol.line), [{ file: path, line: definition.line, note: 'Depends' }]);
        }
      }
    }
  }
  return { routes: [...routes.values()], edges: [...edges.values()], handlers, notes };
}

// The project function a name means in a file: its own, or imported.
function functionOf(modules, path, dotted) {
  const module = modules.get(path);
  const find = (file, name) => {
    const symbol = modules.get(file)?.symbols.find(item => item.name === name && item.kind === 'function');
    return symbol ? { path: file, symbol } : null;
  };
  const [head, ...rest] = dotted.split('.');
  if (!rest.length) {
    const bound = module?.bindings.get(head);
    return find(path, head) ?? (bound && !bound.module ? find(bound.target, bound.name) : null);
  }
  const bound = module?.bindings.get(head);
  return bound?.module && rest.length === 1 ? find(bound.target, rest[0]) : null;
}
