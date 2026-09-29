// Where an action went on the plan (phase 7). Joins the execution capture of
// CodeTAC (a resolved action dossier) with the structure graph: every function
// that ran is tied to a node by a stable key (path relative to the project,
// name and first line, as the capture and the reader both give them), the
// request to its route, and each call to the static arrow that predicted it.
// A call that no static link between its two files predicted becomes an
// observed arrow. What cannot be tied is listed, never hidden.
import { isAbsolute, relative, sep } from 'node:path';
import { routeIndex, matchRoutes } from './node/routes.mjs';

const DATA_BOUNDARIES = new Set(['base-de-dados']);
const EXTERNAL_BOUNDARIES = new Set(['http', 'ia', 'email', 'mensagem', 'pagamento']);
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function traceAction(graph, dossier) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const files = new Map(graph.nodes.filter(node => node.kind === 'file').map(node => [node.path, node]));
  const symbolsOf = new Map();
  for (const node of graph.nodes) {
    if (node.kind !== 'symbol') continue;
    if (!symbolsOf.has(node.file)) symbolsOf.set(node.file, []);
    symbolsOf.get(node.file).push(node);
  }
  const edgeBetween = new Map();
  for (const edge of graph.edges) {
    if (nodes.get(edge.from)?.kind === 'block') continue;
    edgeBetween.set(`${edge.kind}:${edge.from}->${edge.to}`, edge);
  }
  const fileOf = id => { const node = nodes.get(id); return node?.kind === 'file' ? node : node?.kind === 'symbol' ? nodes.get(node.file) : null; };
  const routes = routeIndex(graph.nodes.filter(node => node.kind === 'route'));
  const root = dossier.root;

  const lit = new Set();
  const browserLit = new Set();
  const litEdges = new Set();
  const inferred = new Set();
  const observed = new Map();
  const steps = [];
  const unmatched = [];

  // A project file as the graph names it, or why not.
  const projectPath = file => {
    if (!file || !root) return { why: 'no file' };
    const rel = isAbsolute(file) ? relative(root, file) : file;
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return { why: 'outside the project folder' };
    const path = rel.split(sep).join('/');
    return files.has(path) ? { path } : { why: 'not a file of the plan', path };
  };
  // The node of a function that started at `line` (server), or of a position
  // inside a function (browser): its symbol by key, by line, the innermost
  // top-level symbol containing it, or else its file.
  const locate = (path, name, line, { start }) => {
    const file = files.get(path);
    const symbols = symbolsOf.get(file.id) ?? [];
    if (start) {
      // Same line, other name (a source map's name): only for functions; a
      // callback in a variable's value is inside it (enclosing, below).
      const exact = symbols.find(symbol => symbol.key === `${path}#${name}@${line}`) ?? symbols.find(symbol => symbol.line === line && symbol.symbolKind !== 'variable');
      if (exact) return { node: exact.id, via: exact.key === `${path}#${name}@${line}` ? 'key' : 'line' };
    }
    const around = symbols.filter(symbol => symbol.line <= line && line <= (symbol.endLine ?? symbol.line)).sort((a, b) => b.line - a.line)[0];
    if (around) return { node: around.id, via: start ? 'enclosing' : 'position' };
    return { node: file.id, via: 'file' };
  };
  const record = (source, item, file, name, line, start) => {
    const where = projectPath(file);
    if (!where.path || where.why) {
      unmatched.push({ source, file: where.path ?? file ?? null, function: name ?? null, line: line ?? null, reason: where.why });
      return null;
    }
    if (!Number.isInteger(line) || line < 1) {
      unmatched.push({ source, file: where.path, function: name ?? null, line: null, reason: 'no line (opaque)' });
      return null;
    }
    const found = locate(where.path, name, line, { start });
    steps.push({ source, file: where.path, function: name ?? null, line, node: found.node, via: found.via, ...(item ? { step: item } : {}) });
    if (source === 'browser') browserLit.add(found.node);
    lit.add(found.node);
    lit.add(fileOf(found.node).id);
    return found.node;
  };
  // An arrow between two nodes that ran one after the other.
  const link = (from, to, proof) => {
    if (!from || !to || from === to) return;
    const direct = edgeBetween.get(`calls:${from}->${to}`);
    if (direct) { litEdges.add(direct.id); return; }
    const a = fileOf(from);
    const b = fileOf(to);
    const importing = a && b && (edgeBetween.get(`imports:${a.id}->${b.id}`) ?? null);
    if (importing) { litEdges.add(importing.id); return; }
    if (a && b && a.id === b.id) return;
    const id = `observed:${from}->${to}`;
    if (!observed.has(id)) observed.set(id, { id, kind: 'observed', from, to, origin: 'observed', proof: [] });
    const list = observed.get(id).proof;
    if (!list.some(item => item.file === proof.file && item.line === proof.line)) list.push(proof);
  };
  // After a boundary, the data or external files the function's file imports
  // (also from a data file: the client it goes through). Supabase's REST
  // paths are the database even when its host is not recognised.
  const boundary = (parentNode, step) => {
    const database = DATA_BOUNDARIES.has(step.kind) || (step.kind === 'http' && /^\/(rest|auth|storage)\/v1\//.test(step.path ?? ''));
    const layer = database ? 'block:data' : EXTERNAL_BOUNDARIES.has(step.kind) ? 'block:external' : null;
    const file = parentNode ? fileOf(parentNode) : null;
    if (!layer || !file) return;
    for (const edge of graph.edges) {
      if (edge.kind !== 'imports' || edge.from !== file.id || nodes.get(edge.to)?.block !== layer) continue;
      litEdges.add(edge.id);
      lit.add(edge.to);
    }
  };

  let triggerNode = null;
  for (const item of dossier.timeline ?? []) {
    if (item.type === 'trigger') {
      const origin = item.trigger?.component?.origin?.project ? item.trigger.component.origin : item.trigger?.component?.project?.origin;
      triggerNode = origin?.project ? record('browser', null, origin.file, origin.fn, origin.line, false) : null;
      continue;
    }
    if (item.type !== 'request') continue;
    // Browser: the project functions on the way to the request, outermost
    // first, after the component that was clicked.
    const chainNodes = (item.browser?.chain ?? []).map(frame => record('browser', null, frame.file, frame.fn, frame.line, false)).filter(Boolean);
    if (triggerNode && chainNodes.length) link(triggerNode, chainNodes[0], { file: fileOf(chainNodes[0]).path, line: steps.findLast(step => step.node === chainNodes[0]).line });
    for (let index = 1; index < chainNodes.length; index++) link(chainNodes[index - 1], chainNodes[index], { file: fileOf(chainNodes[index]).path, line: steps.findLast(step => step.node === chainNodes[index]).line });
    // A request from the browser to another origin (Supabase, an API) is a
    // boundary of the code that made it.
    if (item.browser && item.browser.sameOrigin === false && chainNodes.length) boundary(chainNodes.at(-1), { kind: 'http', path: item.browser.path });
    for (const server of item.server ?? []) {
      const request = server.request ?? {};
      const [route] = request.path ? matchRoutes(routes, { method: request.method, path: request.path.split('?')[0] }) : [];
      if (route) lit.add(route.id);
      // The browser code that made the request: its last project frame, or,
      // with none, the client code the static analysis says calls this route.
      if (route && chainNodes.length) link(chainNodes.at(-1), route.id, { file: fileOf(chainNodes.at(-1)).path, line: steps.findLast(step => step.node === chainNodes.at(-1)).line });
      else if (route && item.browser) {
        for (const edge of graph.edges) {
          if (edge.kind !== 'calls' || edge.to !== route.id || !['client', 'both'].includes(edge.runsOn)) continue;
          inferred.add(edge.id);
          lit.add(edge.from);
          lit.add(fileOf(edge.from)?.id);
        }
      }
      const byStep = new Map();
      for (const step of server.steps ?? []) {
        if (step.type === 'function') {
          const node = record('server', step.id, step.file, step.function, step.line, true);
          if (node) byStep.set(step.id, node);
          const parent = step.parentId ? byStep.get(step.parentId) : null;
          if (node && parent) link(parent, node, { file: fileOf(node).path, line: step.line, note: 'observed at run time' });
          else if (node && !step.parentId && route) link(route.id, node, { file: fileOf(node).path, line: step.line, note: 'observed at run time' });
        } else if (step.type === 'boundary') {
          boundary(step.parentId ? byStep.get(step.parentId) : null, step);
        }
      }
    }
  }

  // Browser code that ran → server code that ran, with a static arrow between
  // them and no request in the way (a Server Action).
  for (const edge of graph.edges) {
    if (edge.kind === 'calls' && browserLit.has(edge.from) && lit.has(edge.to) && !browserLit.has(edge.to)) litEdges.add(edge.id);
  }
  // Every call seen across files also lights the import it goes through.
  for (const id of [...litEdges]) {
    const edge = graph.edges.find(item => item.id === id);
    if (edge?.kind !== 'calls') continue;
    const a = fileOf(edge.from);
    const b = fileOf(edge.to);
    const importing = a && b && a.id !== b.id ? edgeBetween.get(`imports:${a.id}->${b.id}`) : null;
    if (importing) litEdges.add(importing.id);
  }
  for (const id of inferred) litEdges.delete(id);
  lit.delete(undefined);
  return {
    action: dossier.actionId ?? null,
    nodes: [...lit].sort(byText),
    edges: [...litEdges].sort(byText),
    inferred: [...inferred].sort(byText),
    observed: [...observed.values()].sort((a, b) => byText(a.id, b.id)),
    steps,
    unmatched,
  };
}

// A request without a browser action (an API called directly): the same
// trace, from its dossier.
export function traceRequest(graph, dossier) {
  return traceAction(graph, { actionId: dossier.request?.requestId ?? null, root: dossier.root, timeline: [{ type: 'request', browser: null, server: [dossier] }] });
}
