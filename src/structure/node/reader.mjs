// The Node reader of StructureTAC (phase 1 onwards): turns a project folder
// into the graph of graph.schema.json. Registered in readers.mjs.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, posix } from 'node:path';
import { describeProject } from './project.mjs';
import { inventory } from './inventory.mjs';
import { projectModules, importedPackages } from './modules.mjs';
import { classify } from './classify.mjs';
import { importEdges, blockEdges } from './edges.mjs';
import { projectRoutes } from './routes.mjs';
import { outgoingServices } from './outgoing.mjs';
import { environment, literalKeyNotes } from './env.mjs';
import { dataModel, tableGraph } from './datamodel.mjs';
import { serviceCatalogue } from '../services.mjs';
import { readConfig } from '../config.mjs';
import { readSuggestions } from '../suggest.mjs';
import { t } from '../text.mjs';


function packageName(folder) {
  try { const name = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')).name; return typeof name === 'string' && name ? name : null; } catch { return null; }
}

function dependencies(folder) {
  try { const pkg = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')); return new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })); } catch { return new Set(); }
}

export const nodeReader = {
  name: 'node',
  version: '0.5.0',
  languages: ['node'],
  detect(folder) {
    return existsSync(join(folder, 'package.json')) ? { types: [] } : null;
  },
  read(folder, { types, cache = true }) {
    const config = readConfig(folder);
    const { files } = inventory(folder, { cache, ignored: config.ignore.length ? path => config.ignore.some(rule => rule.test(path)) : null });
    const modules = projectModules(folder, files, { packages: describeProject(folder).packages, cache });
    const imported = importedPackages(modules);
    const project = describeProject(folder, { importedBy: member => imported.get(member) ?? new Set() });
    const classes = new Map(classify(files, modules, { types: project.types }).map(item => [item.path, item]));
    // The user's layer rules come before the reader's (first match wins), and
    // a file's reclassification wins over both.
    const notes = config.problems.map(message => ({ message }));
    const unusedLayers = new Set(config.layers.map(rule => rule.pattern));
    for (const [path, item] of classes) {
      const rule = config.layers.find(candidate => candidate.test(path));
      if (!rule) continue;
      unusedLayers.delete(rule.pattern);
      classes.set(path, { ...item, layer: rule.layer, rule: `config:${rule.pattern}` });
    }
    for (const pattern of unusedLayers) notes.push({ message: `codetac.structure.json: the layer rule ${pattern} matches no file of the project.` });
    for (const [path, layer] of Object.entries(config.reclassify)) {
      if (classes.has(path)) classes.set(path, { ...classes.get(path), layer, rule: 'manual' });
      else notes.push({ message: `codetac.structure.json reclassifies ${path}, which is not a file of the project.` });
    }
    // AI suggestions (codetac structure --suggest) only fill what is still
    // Unknown, and only while the file is unchanged.
    const suggestions = readSuggestions(folder);
    for (const file of files) {
      const item = classes.get(file.path);
      const suggestion = suggestions[file.path];
      if (item.layer === 'unknown' && item.rule !== 'manual' && suggestion?.hash === file.hash && suggestion.block !== 'unknown') {
        classes.set(file.path, { ...item, layer: suggestion.block, rule: 'ai-suggestion', suggested: true });
      }
    }
    const nodes = files.map(file => {
      const { layer, rule, runsOn, suggested } = classes.get(file.path);
      return { id: `file:${file.path}`, kind: 'file', name: basename(file.path), path: file.path, language: file.language, size: file.size, lines: file.lines,
        hash: file.hash, block: `block:${layer}`, rule, ...(runsOn ? { runsOn } : {}),
        ...(suggested ? { origin: 'ai', confidence: 'possible' } : { origin: 'static' }), proof: [{ file: file.path, line: 1 }] };
    });
    // The symbols of each code file (key = path#name@line, as the capture),
    // plus the inline route handlers.
    const symbolsOf = new Map(files.map(file => [file.path, modules.get(file.path)?.symbols ?? []]));
    const runsOnOf = new Map([...classes.values()].filter(item => item.runsOn).map(item => [item.path, item.runsOn]));
    const found = projectRoutes(modules, symbolsOf, { next: project.types.some(type => type.startsWith('next')), runsOn: runsOnOf });
    notes.push(...found.notes);
    const symbolNode = (path, symbol) => {
      const key = `${path}#${symbol.name}@${symbol.line}`;
      return { id: `symbol:${key}`, kind: 'symbol', name: symbol.name, file: `file:${path}`, symbolKind: symbol.kind, line: symbol.line,
        endLine: symbol.endLine, exported: symbol.exported, ...(symbol.exportedAs ? { exportedAs: symbol.exportedAs } : {}), key, origin: 'static', proof: [{ file: path, line: symbol.line }] };
    };
    for (const file of files) for (const symbol of symbolsOf.get(file.path)) nodes.push(symbolNode(file.path, symbol));
    const ids = new Set(nodes.map(node => node.id));
    for (const { id, path, symbol } of found.handlers) if (!ids.has(id)) nodes.push(symbolNode(path, symbol));
    nodes.push(...found.routes);
    // Modules chosen at run time (phase 8): the folder they load from, when
    // the call says it; a file there with no importer is only possibly dead.
    for (const [path, module] of modules) {
      for (const item of module.runtimeImports ?? []) {
        const folder = item.prefix == null ? null : posix.normalize(posix.join(posix.dirname(path), item.prefix.replace(/[^/]*$/, ''))).replace(/\/?$/, '/').replace(/^\.\//, '');
        const inside = folder && !folder.startsWith('../');
        notes.push({ kind: 'dynamic-import', message: inside ? `${path} loads a module of ${folder === './' ? 'the project root' : folder} chosen at run time: the reading cannot see which.`
          : `${path} loads a module chosen at run time: the reading cannot see which.`, ...(inside ? { path: folder === './' ? '' : folder } : {}), proof: [{ file: path, line: item.line }] });
      }
    }
    // What leaves the machine: services reached by HTTP or by an SDK of the catalogue (phase 4).
    const catalogue = serviceCatalogue(config.services);
    notes.push(...catalogue.problems.map(message => ({ message })));
    const outgoing = outgoingServices(files, modules, { catalogue, symbolsOf, runsOn: runsOnOf });
    nodes.push(...outgoing.nodes);
    // Environment variables: defined in .env* (names only), read in the code (phase 5).
    const env = environment(folder, files, modules, { types: project.types });
    nodes.push(...env.nodes);
    notes.push(...literalKeyNotes(files, modules));
    // Tables defined by the project's schema files and used by its code (phase 6).
    const packages = new Set([...dependencies(folder), ...[...imported.values()].flatMap(set => [...set])]);
    const data = tableGraph(dataModel(folder, files, { packages, modules }), modules, { symbolsOf, packages });
    nodes.push(...data.nodes);
    // One block per layer present, proved by its first file (paths are sorted).
    for (const layer of [...new Set([...classes.values()].map(item => item.layer))]) {
      const first = files.find(file => classes.get(file.path).layer === layer);
      nodes.push({ id: `block:${layer}`, kind: 'block', name: t(`layers.${layer}`), layer, origin: 'static', proof: [{ file: first.path, line: 1 }] });
    }
    // Symbols and routes belong to the block of their file (a route to the
    // file that exposes it).
    const blockOfNode = new Map(nodes.filter(node => node.kind === 'file').map(node => [node.id, node.block]));
    for (const node of nodes) if (node.kind === 'symbol') blockOfNode.set(node.id, blockOfNode.get(node.file));
    for (const edge of found.edges) if (edge.kind === 'exposes') blockOfNode.set(edge.to, blockOfNode.get(edge.from));
    const fileEdges = [...importEdges(modules), ...found.edges];
    const edges = [...fileEdges, ...blockEdges(fileEdges, id => blockOfNode.get(id) ?? null), ...outgoing.edges, ...env.edges, ...data.edges];
    return {
      schemaVersion: 1,
      project: { name: packageName(folder) ?? basename(folder), types: [...new Set([...types, ...project.types])], languages: ['node'] },
      reader: { name: this.name, version: this.version },
      nodes,
      edges,
      ...(notes.length ? { notes } : {}),
    };
  },
};
