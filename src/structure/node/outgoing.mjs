// What leaves the machine (phase 4, step 2): the services the code sends data
// to. Two sources, both read by modules.mjs: HTTP calls with an absolute URL
// or a URL from a variable (fetch, axios, ky…), and clients of the catalogue's
// SDKs (new Pool(…), createClient(…), Sentry.init(…)). The destination is the
// literal host, the variable it comes from, or unknown; never guessed.
// Calls to this computer (localhost) do not leave it and are left out.
const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0)$/;
const MAX_PROOFS = 12;

// The top-level function (or component, class) a line is in, or null: a
// client created at the top of a file, even when kept in an exported
// variable, is the file's (fixtures/structure/README.md).
export function enclosing(symbols, line) {
  return symbols.find(symbol => symbol.kind !== 'variable' && symbol.line <= line && line <= (symbol.endLine ?? symbol.line)) ?? null;
}

// A client's address from what its arguments say, by the catalogue's rule.
function sdkDestination(service, call) {
  const mode = service.destination;
  const info = mode === 'argument' ? call.first ?? Object.values(call.options ?? {})[0]
    : mode ? call.options?.[mode] ?? call.first : null;
  if (info?.env) return { type: 'env', variable: info.env };
  if (info?.host && !LOCAL.test(info.host)) return { type: 'literal', host: info.host };
  const fixed = service.hosts.find(host => !host.startsWith('*.'));
  if (!mode && fixed) return { type: 'literal', host: fixed };
  return { type: 'unknown' };
}

// { nodes, edges } for the files' outgoing calls. symbolsOf: path → symbols;
// runsOn: path → 'client' | 'server' | 'both'.
export function outgoingServices(files, modules, { catalogue, symbolsOf, runsOn }) {
  const services = new Map();
  const edges = new Map();
  const serviceFor = (id, make) => { if (!services.has(id)) services.set(id, { ...make(), proof: [] }); return services.get(id); };
  const link = (path, line, service) => {
    const symbol = enclosing(symbolsOf.get(path) ?? [], line);
    const from = symbol ? `symbol:${path}#${symbol.name}@${symbol.line}` : `file:${path}`;
    const id = `sends-data-to:${from}->${service.id}`;
    if (!edges.has(id)) edges.set(id, { id, kind: 'sends-data-to', from, to: service.id, origin: 'static', proof: [], ...(runsOn.get(path) ? { runsOn: runsOn.get(path) } : {}) });
    const proof = { file: path, line };
    for (const list of [edges.get(id).proof, service.proof]) {
      if (list.length < MAX_PROOFS && !list.some(item => item.file === path && item.line === line)) list.push(proof);
    }
  };
  for (const file of files) {
    const module = modules.get(file.path);
    if (!module) continue;
    for (const call of module.outgoing ?? []) {
      if (call.host) {
        if (LOCAL.test(call.host)) continue;
        const known = catalogue.byHost(call.host);
        const service = known
          ? serviceFor(`service:${known.id}`, () => ({ id: `service:${known.id}`, kind: 'service', name: known.name, category: known.category, destination: { type: 'literal', host: call.host }, origin: 'static' }))
          : serviceFor(`service:${call.host}`, () => ({ id: `service:${call.host}`, kind: 'service', name: call.host, category: 'http', destination: { type: 'literal', host: call.host }, origin: 'static' }));
        link(file.path, call.line, service);
      } else if (call.env) {
        const service = serviceFor(`service:env:${call.env}`, () => ({ id: `service:env:${call.env}`, kind: 'service', name: call.env, category: 'http',
          destination: { type: 'env', variable: call.env }, origin: 'static' }));
        link(file.path, call.line, service);
      }
    }
    for (const call of module.sdk ?? []) {
      const known = catalogue.bySdk(call.package, call.name);
      if (!known) continue;
      const service = serviceFor(`service:${known.id}`, () => ({ id: `service:${known.id}`, kind: 'service', name: known.name, category: known.category,
        destination: sdkDestination(known, call), origin: 'static' }));
      link(file.path, call.line, service);
    }
  }
  return { nodes: [...services.values()], edges: [...edges.values()] };
}
