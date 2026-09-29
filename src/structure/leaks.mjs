// "What leaves the machine" (phase 4, step 5): one row per service the code
// sends data to, from the graph, with where it is called, whether from the
// browser or the server, the jurisdiction the user wrote in the configuration
// (never filled by StructureTAC), and what this session saw going out to it
// (hosts and field names, never values). Calls seen at run time that match
// no service of the graph are listed apart: the code as read did not show them.
const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0|\[?::ffff:127\.\d+\.\d+\.\d+\]?)$/;
const byName = (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || (a.id < b.id ? -1 : 1);
const hostOnly = host => String(host ?? '').toLowerCase().replace(/:\d+$/, '');

// observed: [{ host, fields, source: 'server' | 'browser' }].
export function leaksView(graph, { catalogue, observed = [] }) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const services = graph.nodes.filter(node => node.kind === 'service');
  const sendsTo = new Map();
  for (const edge of graph.edges) if (edge.kind === 'sends-data-to') { if (!sendsTo.has(edge.to)) sendsTo.set(edge.to, []); sendsTo.get(edge.to).push(edge); }
  const ids = new Set(services.map(node => node.id));
  const fileOf = node => (node.kind === 'file' ? node : node.kind === 'symbol' ? nodes.get(node.file) : null);
  const seen = new Map();
  const apart = new Map();
  for (const call of observed) {
    const host = hostOnly(call.host);
    if (!host || LOCAL.test(host)) continue;
    const known = catalogue.byHost(host);
    const id = known && ids.has(`service:${known.id}`) ? `service:${known.id}` : ids.has(`service:${host}`) ? `service:${host}` : null;
    const target = id ? seen : apart;
    const key = id ?? (known ? `service:${known.id}` : `service:${host}`);
    if (!target.has(key)) target.set(key, { calls: 0, fields: new Set(), hosts: new Set(), sources: new Set(), name: known?.name ?? host, category: known?.category ?? 'http' });
    const entry = target.get(key);
    entry.calls += 1;
    entry.hosts.add(host);
    entry.sources.add(call.source ?? 'server');
    for (const field of call.fields ?? []) entry.fields.add(field);
  }
  const shape = entry => entry && { calls: entry.calls, hosts: [...entry.hosts].sort(), fields: [...entry.fields].sort(), sources: [...entry.sources].sort() };
  const rows = services.map(service => {
    const known = service.id.startsWith('service:env:') ? null : catalogue.byId(service.id.slice('service:'.length));
    const calls = (sendsTo.get(service.id) ?? []).map(edge => {
      const from = nodes.get(edge.from);
      const file = from ? fileOf(from) : null;
      return { from: from?.kind === 'symbol' ? from.name : file?.path ?? edge.from, file: edge.proof[0].file, line: edge.proof[0].line,
        runsOn: edge.runsOn ?? file?.runsOn ?? null, proof: edge.proof };
    }).sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
    return { id: service.id, name: service.name, category: service.category, destination: service.destination,
      jurisdiction: known?.jurisdiction ?? null, browser: calls.some(call => call.runsOn === 'client' || call.runsOn === 'both'), calls,
      seen: shape(seen.get(service.id)) ?? null };
  }).sort((a, b) => Number(b.browser) - Number(a.browser) || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0) || byName(a, b));
  const onlySeen = [...apart].map(([id, entry]) => ({ id, name: entry.name, category: entry.category, jurisdiction: catalogue.byId(id.slice('service:'.length))?.jurisdiction ?? null, seen: shape(entry) }))
    .sort(byName);
  return {
    rows, onlySeen,
    summary: { services: rows.length, fromBrowser: rows.filter(row => row.browser).length, withoutJurisdiction: rows.filter(row => !row.jurisdiction).length,
      seen: rows.filter(row => row.seen).length, onlySeen: onlySeen.length },
  };
}
