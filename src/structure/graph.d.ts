// StructureTAC graph, schema version 1. The JSON Schema next to this file
// (graph.schema.json) is the contract; these types say the same for editors.
// Changing either one is a schema decision, written down in
// docs/structuretac/ (architecture rule 5).

export type SchemaVersion = 1;

/** Relative to the project root, forward slashes, never absolute. */
export type ProjectPath = string;
export type Id = string;

export interface Proof {
  file: ProjectPath;
  line: number;
  endLine?: number;
  note?: string;
}

export type Origin = 'static' | 'observed' | 'ai';
export type Confidence = 'certain' | 'possible';
export type RunsOn = 'client' | 'server' | 'both' | 'unknown';
export type Layer = 'interface' | 'routes' | 'logic' | 'data' | 'external' | 'config' | 'utilities' | 'tests' | 'unknown';

interface Common<K extends string> {
  id: Id;
  kind: K;
  name: string;
  /** At least one: every claim points to a file and a line (principle 5). */
  proof: [Proof, ...Proof[]];
  origin: Origin;
  confidence?: Confidence;
}

export interface FileNode extends Common<'file'> {
  path: ProjectPath;
  language: string;
  size: number;
  lines: number;
  /** sha256 of the content, for the incremental cache. */
  hash: string;
  /** Id of the block node the file belongs to. */
  block: Id;
  /** The rule that classified the file: "config:<pattern>" for a layer rule of codetac.structure.json, or "manual". */
  rule: string;
  runsOn?: RunsOn;
}

export interface SymbolNode extends Common<'symbol'> {
  /** Id of the file node. */
  file: Id;
  symbolKind: 'function' | 'class' | 'method' | 'component' | 'variable';
  line: number;
  endLine?: number;
  exported?: boolean;
  /** Other names it is exported under (phase 8): default, or b for export { a as b }. */
  exportedAs?: string[];
  /** path#name@line, shared with the execution capture (phase 7). */
  key: string;
}

export interface BlockNode extends Common<'block'> {
  layer: Layer;
}

export type Destination =
  | { type: 'literal'; host: string }
  | { type: 'env'; variable: string }
  | { type: 'unknown' };

export interface ServiceNode extends Common<'service'> {
  category: 'ai' | 'database' | 'payments' | 'analytics' | 'monitoring' | 'email' | 'messaging' | 'storage' | 'auth' | 'http';
  destination: Destination;
}

export interface TableNode extends Common<'table'> {
  store?: string;
  /** Known only from use in the code, not from a schema. */
  inferred?: boolean;
  /** Where the table is defined (phase 6). Absent when inferred. */
  source?: 'prisma' | 'drizzle' | 'sql' | 'supabase-types';
  columns?: Column[];
  /** Row level security from the SQL files (phase 6). */
  rls?: { enabled: boolean; policies: number; proof: [Proof, ...Proof[]] };
}

export interface Column {
  name: string;
  type?: string;
  primaryKey?: boolean;
  nullable?: boolean;
  unique?: boolean;
  /** By table name, which may be outside the project (auth.users). */
  references?: { table: string; column?: string };
  proof: Proof[];
}

/** An environment variable, by name. There is no field for its value, on purpose. */
export interface EnvNode extends Common<'env'> {
  public?: boolean;
  secretLike?: boolean;
}

export interface RouteNode extends Common<'route'> {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'ANY' | 'ACTION';
  path: string;
}

export type GraphNode = FileNode | SymbolNode | BlockNode | ServiceNode | TableNode | EnvNode | RouteNode;
export type NodeKind = GraphNode['kind'];

export type EdgeKind = 'imports' | 'calls' | 'exposes' | 'reads' | 'writes' | 'sends-data-to' | 'uses-secret' | 'observed';

export interface GraphEdge {
  id: Id;
  kind: EdgeKind;
  from: Id;
  to: Id;
  proof: [Proof, ...Proof[]];
  origin: Origin;
  confidence?: Confidence;
  /** How many links an aggregated edge (between blocks) stands for. */
  count?: number;
  runsOn?: RunsOn;
  /** reads and writes edges (phase 6): what the code does on the table. */
  operations?: Array<'select' | 'insert' | 'update' | 'upsert' | 'delete'>;
  /** imports edges between files (phase 8): the names imported (default, or * for all). */
  names?: string[];
}

export interface Graph {
  schemaVersion: SchemaVersion;
  project: { name: string; types: string[]; languages?: ('node' | 'python')[] };
  reader: { name: string; version: string };
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** What the reader could not see or decide, shown as is. */
  /** kind (phase 5, optional): what the note is, e.g. "literal-key". */
  notes?: { message: string; kind?: string; proof?: [Proof, ...Proof[]] }[];
}

/** A language reader (src/structure/readers.mjs). */
export interface Reader {
  name: string;
  version: string;
  languages: ('node' | 'python')[];
  /** null when the folder is not for this reader; otherwise the project types it recognised. */
  detect(folder: string): { types: string[] } | null | Promise<{ types: string[] } | null>;
  /** The graph of the folder; paths relative to it. */
  read(folder: string, context: { types: string[] }): Graph | Promise<Graph>;
}

export interface ReadResult {
  graph: Graph;
  /** Names of the readers that recognised the folder. */
  readers: string[];
  /** Integrity failures of the readers' output, reported rather than hidden. */
  problems: string[];
}
