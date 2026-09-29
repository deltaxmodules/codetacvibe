// Routes of the project (phase 2, step 3): the API endpoints, the file that
// exposes each one, its handler, and the project functions the handler calls.
// Next.js routes come from the file system (app/**/route.ts, pages/api/**);
// Express, Fastify and similar ones from the registrations the parser found
// (object.get('/path', handler)), joined across files through the mounts
// (app.use('/prefix', router), app.register(plugin, { prefix })). A prefix
// that is not a fixed text is never guessed: that route is left out.
const NEXT_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const byProof = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);

function joinPath(prefix, path) {
  const joined = `${prefix.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`.replace(/\/{2,}/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : '/';
}

// URL path of a Next.js route file: app/api/users/[id]/route.ts → /api/users/:id.
// Route groups (x) and parallel slots @x are not part of the URL.
function nextPath(segments) {
  const parts = segments.filter(part => !/^\(.*\)$/.test(part) && !part.startsWith('@'))
    .map(part => part.replace(/^\[\[?\.\.\.(.+?)\]\]?$/, ':$1*').replace(/^\[(.+)\]$/, ':$1'));
  return `/${parts.join('/')}`.replace(/\/index$/, '') || '/';
}
function nextRouteFile(path, next) {
  if (!next) return null;
  const app = path.match(/^(?:(.*)\/)?(?:src\/)?app\/((?:.+\/)?)route\.[mc]?[jt]s$/);
  if (app) return { router: 'app', path: nextPath(app[2].split('/').filter(Boolean)) };
  const pages = path.match(/^(?:(.*)\/)?(?:src\/)?pages\/(api(?:\/.+)?)\.[mc]?[jt]sx?$/);
  if (pages) return { router: 'pages', path: nextPath(pages[2].split('/')) };
  return null;
}

// The routes that answer a request: same method (or ANY; any method when the
// request's method is not a fixed text), and a path that fits the route's
// pattern (:id takes one segment, :path* the rest). A part of the request
// built at run time (:param) only fits a parameter. The most specific routes
// win (fewest parameters), as a literal segment is usually registered first.
// The routes sit in a tree of segments, so a request only visits the
// branches it can take (a large project has thousands of routes under /api).
export function routeIndex(routes) {
  const root = { literal: new Map(), param: null, rest: [], here: [] };
  for (const route of routes) {
    let node = root;
    for (const part of route.path.split('/').filter(Boolean)) {
      if (part.startsWith(':') && part.endsWith('*')) { node.rest.push(route); node = null; break; }
      if (part.startsWith(':')) node = node.param ??= { literal: new Map(), param: null, rest: [], here: [] };
      else {
        if (!node.literal.has(part)) node.literal.set(part, { literal: new Map(), param: null, rest: [], here: [] });
        node = node.literal.get(part);
      }
    }
    if (node) node.here.push(route);
  }
  return root;
}
export function matchRoutes(index, request) {
  const parts = request.path.split('/').filter(Boolean);
  const found = [];
  const visit = (node, depth, params) => {
    for (const route of node.rest) found.push([route, params + 1]);
    if (depth === parts.length) { for (const route of node.here) found.push([route, params]); return; }
    const part = parts[depth];
    if (part !== ':param' && node.literal.has(part)) visit(node.literal.get(part), depth + 1, params);
    if (node.param) visit(node.param, depth + 1, params + 1);
  };
  visit(index, 0, 0);
  const scored = found.filter(([route]) => !request.method || route.method === request.method || route.method === 'ANY');
  const best = Math.min(...scored.map(([, score]) => score));
  return [...new Set(scored.filter(([, score]) => score === best).map(([route]) => route))];
}

// symbols: Map path → [symbol]; modules: Map path → module (with bindings).
export function projectRoutes(modules, symbolsOf, { next = false, runsOn = new Map() } = {}) {
  const routes = new Map();
  const edges = new Map();
  const extraSymbols = [];
  const symbolId = (path, symbol) => `symbol:${path}#${symbol.name}@${symbol.line}`;
  const addEdge = (kind, from, to, proof) => {
    const id = `${kind}:${from}->${to}`;
    if (!edges.has(id)) edges.set(id, { id, kind, from, to, origin: 'static', proof: [] });
    const list = edges.get(id).proof;
    for (const item of proof) if (!list.some(entry => entry.file === item.file && entry.line === item.line)) list.push(item);
  };
  const addRoute = (method, path, proof) => {
    const id = `route:${method} ${path}`;
    if (!routes.has(id)) routes.set(id, { id, kind: 'route', name: `${method} ${path}`, method, path, origin: 'static', proof: [] });
    const list = routes.get(id).proof;
    for (const item of proof) if (!list.some(entry => entry.file === item.file && entry.line === item.line)) list.push(item);
    return id;
  };

  // The local symbol behind an exported name of a file.
  const exportedSymbol = (path, name) => {
    const module = modules.get(path);
    if (!module) return null;
    const item = module.exports.find(entry => entry.name === name);
    const local = item ? item.local ?? item.name : name === 'default' ? null : name;
    return local ? (symbolsOf.get(path) ?? []).find(symbol => symbol.name === local) ?? null : null;
  };
  // What a name used in a file refers to: its own top-level symbol, or an
  // imported one. Returns { path, symbol } or null.
  const resolveName = (path, name, object) => {
    const module = modules.get(path);
    if (object) {
      // import * as ns, or a CommonJS module taken whole (require('…').name).
      const namespace = module?.bindings.find(binding => binding.local === object && binding.target && (binding.imported === '*'
        || (binding.imported === 'default' && modules.get(binding.target)?.exports.some(entry => entry.commonjs && entry.name === name))));
      if (!namespace) return null;
      const symbol = exportedSymbol(namespace.target, name);
      return symbol ? { path: namespace.target, symbol } : null;
    }
    const own = (symbolsOf.get(path) ?? []).find(symbol => symbol.name === name);
    if (own) return { path, symbol: own };
    const binding = module?.bindings.find(item => item.local === name && item.target);
    if (!binding || binding.imported === '*') return null;
    const symbol = exportedSymbol(binding.target, binding.imported);
    return symbol ? { path: binding.target, symbol } : null;
  };
  // Handler → the project functions it calls directly (not variables).
  const linkCalls = (fromId, path, calls) => {
    for (const call of calls ?? []) {
      const found = resolveName(path, call.name, call.object);
      if (!found || found.symbol.kind === 'variable') continue;
      const toId = symbolId(found.path, found.symbol);
      if (toId !== fromId) addEdge('calls', fromId, toId, [{ file: path, line: call.line }]);
    }
  };

  // Next.js: the file is the route.
  for (const path of modules.keys()) {
    const route = nextRouteFile(path, next);
    if (!route) continue;
    const handlers = route.router === 'app'
      ? NEXT_METHODS.map(method => [method, exportedSymbol(path, method)])
      : [['ANY', exportedSymbol(path, 'default')]];
    for (const [method, symbol] of handlers) {
      if (!symbol || symbol.kind === 'variable') continue;
      const proof = [{ file: path, line: symbol.line }];
      const id = addRoute(method, route.path, proof);
      addEdge('exposes', `file:${path}`, id, proof);
      addEdge('calls', id, symbolId(path, symbol), proof);
      linkCalls(symbolId(path, symbol), path, symbol.calls);
    }
  }

  // Registered routes. A router is a (file, name) pair: the object's name, or
  // for a plugin the function that receives the object.
  const keyOf = (path, entry) => `${path}#${entry.plugin ?? entry.object}`;
  const mountsOf = new Map();
  for (const [path, module] of modules) {
    for (const mount of module.mounts ?? []) {
      let child = null;
      const binding = mount.ref ? module.bindings.find(item => item.local === mount.ref && item.target)
        : mount.target ? { target: mount.target, imported: 'default' } : null;
      if (!mount.ref && !binding) continue;
      if (binding) {
        const item = modules.get(binding.target)?.exports.find(entry => entry.name === binding.imported);
        child = `${binding.target}#${item ? item.local ?? item.name : binding.imported}`;
      } else child = `${path}#${mount.ref}`;
      if (!mountsOf.has(child)) mountsOf.set(child, []);
      mountsOf.get(child).push({ parent: keyOf(path, mount), prefix: mount.prefix, proof: { file: path, line: mount.line } });
    }
  }
  const prefixes = (key, seen = new Set()) => {
    const mounts = mountsOf.get(key);
    if (!mounts?.length || seen.has(key)) return [{ prefix: '', proof: [] }];
    seen.add(key);
    return mounts.flatMap(mount => prefixes(mount.parent, new Set(seen))
      .map(outer => ({ prefix: joinPath(outer.prefix, mount.prefix), proof: [...outer.proof, mount.proof] })));
  };
  for (const [path, module] of modules) {
    for (const route of module.routes ?? []) {
      const method = route.method === 'all' ? 'ANY' : route.method.toUpperCase();
      let handlerId = null;
      let handlerProof = null;
      if (route.handler?.inline) {
        const symbol = { name: route.handler.name, kind: 'function', line: route.handler.line, endLine: route.handler.endLine, exported: false, calls: route.handler.calls };
        handlerId = symbolId(path, symbol);
        if (!extraSymbols.some(item => item.id === handlerId)) extraSymbols.push({ id: handlerId, path, symbol });
        handlerProof = { file: path, line: route.handler.line };
        linkCalls(handlerId, path, route.handler.calls);
      } else if (route.handler?.ref) {
        const found = resolveName(path, route.handler.ref);
        if (found && found.symbol.kind !== 'variable') {
          handlerId = symbolId(found.path, found.symbol);
          handlerProof = { file: path, line: route.line };
          linkCalls(handlerId, found.path, found.symbol.calls);
        }
      }
      for (const outer of prefixes(keyOf(path, route))) {
        const definition = { file: path, line: route.line };
        const id = addRoute(method, joinPath(outer.prefix, route.path), [definition, ...outer.proof]);
        addEdge('exposes', `file:${path}`, id, [definition]);
        if (handlerId) addEdge('calls', id, handlerId, [handlerProof]);
      }
    }
  }

  // Client → server. A request with a fixed path goes to the route(s) that
  // answer it; one built at run time, or with no route in the project, is a
  // note ("unknown destination"), never a guess. A call from client code to a
  // function of a 'use server' file is a Server Action.
  const notes = [];
  const routeList = [...routes.values()];
  const index = routeIndex(routeList);
  const from = (path, line) => {
    const symbol = (symbolsOf.get(path) ?? []).find(item => item.kind !== 'variable' && item.line <= line && line <= item.endLine);
    return symbol ? symbolId(path, symbol) : `file:${path}`;
  };
  const edgeRunsOn = path => (runsOn.get(path) ? { runsOn: runsOn.get(path) } : {});
  for (const [path, module] of modules) {
    for (const request of module.requests ?? []) {
      const proof = [{ file: path, line: request.line }];
      if (request.dynamic) {
        notes.push({ message: `Unknown destination: the URL of this ${request.client}() call is built at run time.`, proof });
        continue;
      }
      const matches = matchRoutes(index, request);
      if (!matches.length) {
        notes.push({ message: `No route of the project answers ${request.method ?? 'a request to'} ${request.path} (${request.client}() call).`, proof });
        continue;
      }
      for (const route of matches) {
        const id = `calls:${from(path, request.line)}->${route.id}`;
        const isNew = !edges.has(id);
        addEdge('calls', from(path, request.line), route.id, proof);
        const edge = edges.get(id);
        Object.assign(edge, edgeRunsOn(path));
        // Possible only while no request behind the arrow has a fixed method.
        if (!request.method && isNew) edge.confidence = 'possible';
        else if (request.method) delete edge.confidence;
      }
    }
    if (!['client', 'both'].includes(runsOn.get(path))) continue;
    for (const symbol of symbolsOf.get(path) ?? []) {
      for (const call of symbol.calls ?? []) {
        const found = resolveName(path, call.name, call.object);
        if (!found || found.path === path || found.symbol.kind === 'variable' || !modules.get(found.path)?.directives.includes('use server')) continue;
        const fromId = symbolId(path, symbol);
        addEdge('calls', fromId, symbolId(found.path, found.symbol), [{ file: path, line: call.line, note: 'Server Action' }]);
        Object.assign(edges.get(`calls:${fromId}->${symbolId(found.path, found.symbol)}`), edgeRunsOn(path));
      }
    }
  }
  const sorted = list => list.map(item => ({ ...item, proof: item.proof.sort(byProof) }));
  return { routes: sorted(routeList), edges: sorted([...edges.values()]), handlers: extraSymbols, notes };
}
