// StructureTAC readers: one per language, all returning the same graph
// (graph.schema.json). The interface only ever sees the graph.
//
// A reader is { name, version, languages, detect(folder), read(folder, context) }:
// - detect returns null when the folder is not for it, or { types: [...] }
//   (the project types it recognised, for example next-app-router);
// - read returns (or resolves to) a graph of schema version 1, with paths
//   relative to the folder.
// readProject runs every reader that recognises the folder, merges what they
// return (a Node frontend with a Python backend is one project), puts the
// result in a stable order and checks it. It never refuses a folder: with no
// reader, the graph is empty and says why.
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { checkGraph } from './validate.mjs';
import { nodeReader } from './node/reader.mjs';

export const SCHEMA_VERSION = 1;

// Built-in readers, in the order they are asked. The Python reader arrives in
// phase 11. (defineReader is a function declaration, so it is ready here.)
export const builtInReaders = [defineReader(nodeReader)];

export function defineReader(reader) {
  const problems = [];
  if (!reader || typeof reader !== 'object') throw new TypeError('A reader must be an object.');
  for (const field of ['name', 'version']) if (typeof reader[field] !== 'string' || !reader[field]) problems.push(`"${field}" must be a non-empty string`);
  for (const method of ['detect', 'read']) if (typeof reader[method] !== 'function') problems.push(`"${method}" must be a function`);
  if (!Array.isArray(reader.languages) || !reader.languages.every(language => ['node', 'python'].includes(language))) {
    problems.push('"languages" must list node and/or python');
  }
  if (problems.length) throw new TypeError(`Reader ${reader.name ?? '(no name)'}: ${problems.join('; ')}.`);
  return Object.freeze({ ...reader });
}

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byProof = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);

// Same content, same order: nodes and edges by id, proofs by file and line,
// project types sorted. Running a reader twice must give identical output.
export function canonical(graph) {
  const sortProofs = item => (item.proof ? { ...item, proof: [...item.proof].sort(byProof) } : item);
  return {
    schemaVersion: graph.schemaVersion,
    project: { ...graph.project, types: [...new Set(graph.project.types)].sort(), ...(graph.project.languages ? { languages: [...new Set(graph.project.languages)].sort() } : {}) },
    reader: graph.reader,
    nodes: graph.nodes.map(sortProofs).sort(byId),
    edges: graph.edges.map(sortProofs).sort(byId),
    ...(graph.notes?.length ? { notes: graph.notes.map(sortProofs) } : {}),
  };
}

// Merges the graphs of several readers. A node both readers report (the same
// id: a shared .env file, a table) is kept once, with the proofs of both.
function merge(graphs, name) {
  const nodes = new Map();
  const edges = new Map();
  const notes = [];
  for (const graph of graphs) {
    for (const node of graph.nodes) {
      const known = nodes.get(node.id);
      if (!known) nodes.set(node.id, node);
      else {
        const seen = new Set(known.proof.map(proof => JSON.stringify(proof)));
        nodes.set(node.id, { ...known, proof: [...known.proof, ...node.proof.filter(proof => !seen.has(JSON.stringify(proof)))] });
      }
    }
    for (const edge of graph.edges) if (!edges.has(edge.id)) edges.set(edge.id, edge);
    notes.push(...(graph.notes ?? []));
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    project: { name: graphs.length === 1 && graphs[0].project?.name ? graphs[0].project.name : name, types: graphs.flatMap(graph => graph.project.types), languages: graphs.flatMap(graph => graph.project.languages ?? []) },
    reader: graphs.length === 1 ? graphs[0].reader : { name: graphs.map(graph => graph.reader.name).join('+'), version: graphs.map(graph => graph.reader.version).join('+') },
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    notes,
  };
}

// Reads a project folder. Returns { graph, readers, problems }: problems are
// integrity failures of the readers' output (a reader bug), reported rather
// than hidden; the graph is returned anyway.
export async function readProject(folder, { readers = builtInReaders } = {}) {
  const root = realpathSync(folder);
  const name = basename(root);
  const chosen = [];
  for (const reader of readers) {
    let found = null;
    try { found = await reader.detect(root); } catch {}
    if (found) chosen.push({ reader, types: found.types ?? [] });
  }
  if (!chosen.length) {
    const graph = canonical({ schemaVersion: SCHEMA_VERSION, project: { name, types: [] }, reader: { name: 'none', version: '0' }, nodes: [], edges: [],
      notes: [{ message: 'No reader recognised this folder, so its structure is not shown.' }] });
    return { graph, readers: [], problems: [] };
  }
  const graphs = [];
  const problems = [];
  for (const { reader, types } of chosen) {
    try {
      const graph = await reader.read(root, { types });
      if (graph?.schemaVersion !== SCHEMA_VERSION) problems.push(`Reader ${reader.name} returned schema version ${graph?.schemaVersion}, not ${SCHEMA_VERSION}.`);
      graphs.push({ ...graph, project: { ...graph.project, types: [...new Set([...types, ...(graph.project?.types ?? [])])] }, reader: { name: reader.name, version: reader.version } });
    } catch (error) {
      problems.push(`Reader ${reader.name} failed: ${String(error?.message ?? error).slice(0, 300)}`);
      graphs.push({ schemaVersion: SCHEMA_VERSION, project: { name, types, languages: reader.languages }, reader: { name: reader.name, version: reader.version },
        nodes: [], edges: [], notes: [{ message: `The ${reader.name} reader failed, so this part of the project is not shown.` }] });
    }
  }
  const graph = canonical(merge(graphs, name));
  problems.push(...checkGraph(graph));
  // Paths are relative: the absolute folder (which names the user and the
  // machine) must never be in the graph.
  if (JSON.stringify(graph).includes(root)) problems.push('The graph contains the absolute path of the project folder.');
  return { graph, readers: chosen.map(({ reader }) => reader.name), problems };
}
