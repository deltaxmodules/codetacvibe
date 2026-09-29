// Local store: ingests the JSONL recordings into an SQLite database inside
// CodeTAC's own folder and builds the dossier of each HTTP request.
import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { label as display } from './sentences.mjs';

const WRITES = new Set(['INSERT', 'UPDATE', 'DELETE', 'UPSERT', 'REPLACE', 'MERGE']);
const STRUCTURE = new Set(['CREATE', 'DROP', 'ALTER', 'TRUNCATE']);
const KINDS = { a: 'link', button: 'button', input: 'field', select: 'list', textarea: 'text box', label: 'label', summary: 'section', form: 'form' };

// 'button “Sign in”': the element as the person saw it.
export function actionLabel(trigger) {
  const element = trigger?.element;
  if (!element) return 'continuation after navigation';
  const button = element.role === 'button' || (element.tag === 'input' && /^(submit|button|reset)$/.test(element.type ?? ''));
  const kind = button ? 'button' : KINDS[element.tag] ?? element.role ?? element.tag ?? 'element';
  const text = element.text || element.label || element.name || element.id;
  const suffix = trigger.event === 'change' ? (element.type === 'file' ? ' (file chosen)' : ' (change)') : '';
  return `${kind}${text ? ` “${text}”` : ''}${suffix}`;
}

// The deepest folder that holds both paths (absolute, "/"-separated).
export function commonFolder(a, b) {
  const left = a.split('/');
  const right = b.split('/');
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index++;
  return left.slice(0, index).join('/') || '/';
}

export function openStore(folder, { keep = 500, keepRuns = 20 } = {}) {
  const directory = resolve(folder);
  // A new installation has no data folder yet (~/.codetac).
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, 'codetac.db'));
  db.exec(`
    pragma journal_mode = wal;
    create table if not exists ingested (file text primary key, offset integer not null);
    create table if not exists runs (run text primary key, root text, node text, level text);
    create table if not exists requests (request_id text primary key, run text, process text, method text, path text,
      query_keys text, at integer, status integer, duration_ns integer, aborted integer, ended integer not null default 0);
    create table if not exists events (request_id text not null, process text, sequence integer, type text, id text, data text);
    create index if not exists events_request on events(request_id);
    create table if not exists limitations (run text, file text, reason text, line integer, detail text,
      unique(run, file, reason, line));
    create table if not exists actions (action_id text not null, segment integer not null, run text, at integer, data text,
      primary key(action_id, segment));
    create table if not exists origins (key text primary key, data text not null);
    create table if not exists purposes (key text primary key, data text not null, at integer);
  `);
  // Recordings made before the browser link have no action columns.
  const columns = new Set(db.prepare('pragma table_info(requests)').all().map(column => column.name));
  if (!columns.has('action')) db.exec('alter table requests add column action text; alter table requests add column action_request integer;');
  if (!columns.has('cookies')) db.exec('alter table requests add column cookies text;');
  // Phase 5: the request that loaded a page (it received the bar).
  if (!columns.has('document')) db.exec('alter table requests add column document integer;');
  // Python stage 9: where the request ended in its process, to tell the work
  // done after the response (background tasks) from the rest.
  if (!columns.has('end_sequence')) db.exec('alter table requests add column end_sequence integer;');
  // Python stage 10 (DP3): requests from a page of another origin, for the probable link.
  if (!columns.has('origin')) db.exec('alter table requests add column origin text; alter table requests add column host text;');
  db.exec('create index if not exists requests_action on requests(action)');
  // Phase 5: why a recording is in minimal mode.
  if (!db.prepare('pragma table_info(runs)').all().some(column => column.name === 'reason')) db.exec('alter table runs add column reason text;');
  // Offsets used to be kept by the path as given, so opening the store from
  // another working directory read every recording again and duplicated its
  // events. They are now kept relative to the store's folder.
  if (db.prepare("select 1 from sqlite_master where type = 'table' and name = 'files'").get()) {
    db.exec('begin');
    const move = db.prepare('insert into ingested(file, offset) values (?, ?) on conflict(file) do update set offset = max(offset, excluded.offset)');
    for (const row of db.prepare('select path, offset from files').all()) {
      if (row.path.startsWith(directory + sep)) move.run(relative(directory, row.path), row.offset);
    }
    db.exec(`drop table files;
      delete from events where rowid not in (select min(rowid) from events group by request_id, process, sequence, type);
      commit;`);
  }
  db.exec('create unique index if not exists events_unique on events(request_id, process, sequence, type)');
  const statements = {
    offset: db.prepare('select offset from ingested where file = ?'),
    setOffset: db.prepare('insert into ingested(file, offset) values (?, ?) on conflict(file) do update set offset = excluded.offset'),
    run: db.prepare('insert into runs(run, root, node, level, reason) values (?, ?, ?, ?, ?) on conflict(run) do update set root = excluded.root, node = coalesce(excluded.node, runs.node), level = excluded.level, reason = excluded.reason'),
    runRoot: db.prepare('select root from runs where run = ?'),
    probable: db.prepare('select request_id, method, at from requests where action is null and origin = ? and host = ? and path = ? and at between ? and ? order by at'),
    request: db.prepare('insert or ignore into requests(request_id, run, process, method, path, query_keys, at, action, action_request, origin, host) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    action: db.prepare('insert or replace into actions(action_id, segment, run, at, data) values (?, ?, ?, ?, ?)'),
    requestEnd: db.prepare('update requests set status = ?, duration_ns = ?, aborted = ?, cookies = ?, ended = 1, end_sequence = ? where request_id = ? and process = ?'),
    event: db.prepare('insert or ignore into events(request_id, process, sequence, type, id, data) values (?, ?, ?, ?, ?, ?)'),
    limitation: db.prepare('insert or ignore into limitations(run, file, reason, line, detail) values (?, ?, ?, ?, ?)'),
    document: db.prepare('update requests set document = 1 where request_id = ?'),
  };
  // A page event and the request that follows it with the same path, by process.
  const pages = new Map();
  const documents = new Set();

  // Reads only the bytes appended since the previous ingestion.
  function ingestFile(run, path) {
    const size = statSync(path).size;
    const key = relative(directory, path);
    const from = statements.offset.get(key)?.offset ?? 0;
    if (size <= from) return;
    const fd = openSync(path, 'r');
    let text;
    try {
      const buffer = Buffer.alloc(Math.min(size - from, 64 * 1024 * 1024));
      const read = readSync(fd, buffer, 0, buffer.length, from);
      text = buffer.subarray(0, read).toString('utf8');
    } finally { closeSync(fd); }
    const complete = text.lastIndexOf('\n');
    if (complete < 0) return;
    for (const line of text.slice(0, complete).split('\n')) {
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      switch (event.type) {
        case 'capture-start': {
          // Several processes may share a recording (a Vite frontend and a
          // Python API): the root is the folder common to all of theirs.
          const known = statements.runRoot.get(run)?.root;
          statements.run.run(run, known && event.root ? commonFolder(known, event.root) : event.root ?? known ?? null,
            event.node ?? null, event.level ?? null, event.reason ?? null);
          break;
        }
        case 'page': pages.set(event.process, event.path); break;
        case 'request':
          if (pages.get(event.process) === event.path) { pages.delete(event.process); documents.add(event.requestId); }
          statements.request.run(event.requestId, run, event.process, event.method, event.path,
          JSON.stringify(event.queryKeys ?? []), event.at ?? null, event.action ?? null, event.actionRequest ?? null, event.origin ?? null, event.host ?? null);
          if (documents.has(event.requestId)) statements.document.run(event.requestId);
          break;
        case 'browser-action': statements.action.run(event.actionId, event.segment ?? 1, run, event.startedAt ?? null, line); break;
        case 'request-end': statements.requestEnd.run(event.status ?? null, event.durationNs ?? null, event.aborted ? 1 : 0,
          event.cookies ? JSON.stringify(event.cookies) : null, event.sequence ?? null, event.requestId, event.process); break;
        case 'limitation': statements.limitation.run(run, event.file ?? '', event.reason ?? '', event.line ?? null, event.detail ?? null); break;
        case 'enter': case 'exit': case 'boundary': case 'boundary-end': case 'detail':
          if (event.requestId) statements.event.run(event.requestId, event.process, event.sequence, event.type, event.id, line);
          break;
      }
    }
    statements.setOffset.run(key, from + Buffer.byteLength(text.slice(0, complete + 1)));
  }

  function ingest() {
    if (!existsSync(directory)) return;
    db.exec('begin');
    try {
      for (const run of readdirSync(directory)) {
        const folder = join(directory, run);
        if (run === 'projetos' || /^(test|bundle)-/.test(run) || !statSync(folder).isDirectory()) continue;
        for (const name of readdirSync(folder)) if (name.endsWith('.jsonl')) ingestFile(run, join(folder, name));
      }
      // History: the last `keep` requests of each recording, and the last `keepRuns` recordings.
      const remove = db.prepare('delete from events where request_id = ?');
      const removeRequest = db.prepare('delete from requests where request_id = ?');
      const runs = db.prepare('select run, max(at) as last, count(*) as n from requests group by run order by last desc').all();
      runs.forEach((entry, index) => {
        const excess = index >= keepRuns ? entry.n : entry.n - keep;
        if (excess <= 0) return;
        // Within a recording, files served without anything of the project in
        // them (Vite modules, images…) go first: a single page may load more
        // than a thousand, and the page load itself must stay.
        const order = index >= keepRuns ? 'at asc' : `(action is null and document is null
          and not exists (select 1 from events e where e.request_id = requests.request_id)) desc, at asc`;
        for (const { request_id: id } of db.prepare(`select request_id from requests where run = ? order by ${order} limit ?`).all(entry.run, excess)) {
          remove.run(id);
          removeRequest.run(id);
        }
      });
      // Browser actions follow the same rule, by recording.
      for (const entry of db.prepare('select run, count(distinct action_id) as n from actions group by run').all()) {
        const excess = entry.n - keep;
        if (excess <= 0) continue;
        db.prepare(`delete from actions where action_id in (select action_id from actions where run = ?
          group by action_id order by min(at) asc limit ?)`).run(entry.run, excess);
      }
      db.exec('commit');
    } catch (error) {
      db.exec('rollback');
      throw error;
    }
  }

  function listRuns() {
    return db.prepare(`select run, max(last) as last, sum(requests) as requests, sum(actions) as actions from (
        select run, max(at) as last, count(*) as requests, 0 as actions from requests group by run
        union all select run, max(at) as last, 0, count(distinct action_id) from actions group by run)
      group by run order by last desc`).all();
  }

  function listActions({ limit = 200, run } = {}) {
    const rows = db.prepare(`select action_id, run, min(at) as at, count(*) as segments from actions
      ${run ? 'where run = ?' : ''} group by action_id order by at desc limit ?`).all(...(run ? [run, limit] : [limit]));
    const first = db.prepare('select data from actions where action_id = ? order by segment limit 1');
    const counts = db.prepare(`select count(*) as requests, sum(ended) as ended from requests where action = ?`);
    return rows.map(row => {
      const data = JSON.parse(first.get(row.action_id).data);
      const server = counts.get(row.action_id);
      return { actionId: row.action_id, run: row.run, at: row.at, segments: row.segments, label: actionLabel(data.trigger),
        page: data.page?.path, browserRequests: data.requests?.length ?? 0, serverRequests: server.requests, pending: server.requests > (server.ended ?? 0) };
    });
  }

  // The same action seen by the browser (segments: one per page it crossed)
  // and by the server (requests carrying its id), in one sequence.
  function actionDossier(actionId) {
    const segments = db.prepare('select run, data from actions where action_id = ? order by segment').all(actionId)
      .map(row => ({ run: row.run, ...JSON.parse(row.data) }));
    const serverRows = db.prepare('select * from requests where action = ? order by at, request_id').all(actionId);
    if (!segments.length && !serverRows.length) return null;
    const server = serverRows.map(row => ({ number: row.action_request, dossier: dossier(row.request_id) }));
    const used = new Set();
    const timeline = [];
    const take = number => server.filter(item => item.number === number && !used.has(item.dossier.request.requestId))
      .map(item => { used.add(item.dossier.request.requestId); return item.dossier; });
    // DP3 (b): a request of the page to another origin (the API on another
    // port, without a proxy) cannot carry the action without changing the
    // app (CORS). It is linked, as probable, to the request that server got
    // from this page's origin, for the same host, method and path, while the
    // browser waited for it; the CORS preflight (OPTIONS) goes with it.
    const claimed = new Set();
    const linked = new Set();  // browser requests with a probable link: the app's own API, not an outside service
    const probable = (segment, request) => {
      if (request.sameOrigin || !request.host || !segment.origin || segment.startedAt == null || request.startMs == null) return [];
      const start = segment.startedAt + request.startMs;
      const end = start + (request.durationMs ?? 0);
      const rows = statements.probable.all(segment.origin, request.host, request.path ?? '', start - 250, end + 250)
        .filter(row => !claimed.has(row.request_id));
      const main = rows.filter(row => row.method === request.method).sort((a, b) => Math.abs(a.at - start) - Math.abs(b.at - start))[0];
      if (!main) return [];
      const preflight = rows.find(row => row.method === 'OPTIONS' && row.at <= main.at);
      linked.add(request);
      return [preflight, main].filter(Boolean).map(row => { claimed.add(row.request_id); return dossier(row.request_id); });
    };
    segments.forEach((segment, index) => {
      if (index === 0 && segment.trigger) timeline.push({ type: 'trigger', segment: segment.segment, page: segment.page, trigger: segment.trigger });
      if (index > 0 || !segment.trigger) {
        // A new document: the request that loaded it carries the action in a cookie.
        timeline.push({ type: 'document', segment: segment.segment, page: segment.page, server: take(null) });
      }
      const events = [
        ...(segment.requests ?? []).map(request => {
          const server = take(request.n);
          const guessed = server.length ? [] : probable(segment, request);
          return { at: request.startMs ?? 0, item: { type: 'request', segment: segment.segment, browser: request, server: server.length ? server : guessed,
            ...(guessed.length ? { probable: true } : {}) } };
        }),
        ...(segment.navigations ?? []).filter(item => item.kind !== 'document' && item.kind !== 'documento')
          .map(navigation => ({ at: navigation.atMs ?? 0, item: { type: 'navigation', segment: segment.segment, ...navigation } })),
      ].sort((a, b) => a.at - b.at);
      for (const { item } of events) timeline.push(item);
      timeline.push({ type: 'screen', segment: segment.segment, page: segment.page, screen: segment.screen ?? {}, durationMs: segment.durationMs,
        closedBy: segment.closedBy });
    });
    // Requests the server saw for this action but the browser did not report
    // (the page closed before sending, or a request made on its behalf).
    const rest = server.filter(item => !used.has(item.dossier.request.requestId)).map(item => item.dossier);
    if (rest.length) timeline.push({ type: 'unmatched', server: rest });

    const all = timeline.flatMap(item => item.server ?? []);
    const combined = [];
    for (const mark of all.flatMap(item => item.marks)) {
      const found = combined.find(entry => entry.key === mark.key);
      if (found) found.count += mark.count; else combined.push({ ...mark });
    }
    for (const request of segments.flatMap(segment => segment.requests ?? []).filter(request => !request.sameOrigin && request.host && !linked.has(request))) {
      const key = `browser:${request.host}`;
      const found = combined.find(entry => entry.key === key);
      if (found) found.count++; else combined.push({ key, count: 1, label: `browser call to ${request.host}` });
    }
    const runs = [...new Set([...segments.map(segment => segment.run), ...serverRows.map(row => row.run)])];
    const limitations = runs.flatMap(run => db.prepare('select reason, count(*) as count from limitations where run = ? group by reason').all(run));
    const first = segments[0];
    return {
      actionId, run: first?.run ?? serverRows[0]?.run, label: first ? actionLabel(first.trigger) : 'action not reported by the browser', origin: first?.origin ?? null,
      startedAt: first?.startedAt ?? serverRows[0]?.at ?? null,
      durationMs: segments.reduce((total, segment) => total + (segment.durationMs ?? 0), 0) || null,
      browserSeen: segments.length > 0, pending: all.some(item => !item.request.ended),
      scripts: [...new Set(segments.flatMap(segment => segment.scripts ?? []))],
      root: runs.map(run => root(run)).find(Boolean) ?? null, ...runLevel(runs),
      timeline, marks: combined, limitations,
    };
  }

  function listRequests({ limit = 200, run, withoutAction = false } = {}) {
    const filter = withoutAction ? ' and action is null' : '';
    const rows = run
      ? db.prepare(`select * from requests where run = ?${filter} order by at desc limit ?`).all(run, limit)
      : db.prepare(`select * from requests where 1${filter} order by at desc limit ?`).all(limit);
    const count = db.prepare("select sum(type = 'enter') as functions, sum(type = 'boundary') as boundaries from events where request_id = ?");
    return rows.map(row => ({ ...shapeRequest(row), ...count.get(row.request_id) }));
  }

  function shapeRequest(row) {
    return { requestId: row.request_id, run: row.run, action: row.action ?? null, method: row.method, path: row.path,
      queryKeys: JSON.parse(row.query_keys ?? '[]'), at: row.at, status: row.status,
      durationMs: row.duration_ns == null ? null : row.duration_ns / 1e6, aborted: Boolean(row.aborted), ended: Boolean(row.ended),
      cookies: row.cookies ? JSON.parse(row.cookies) : [] };
  }

  function dossier(requestId) {
    const row = db.prepare('select * from requests where request_id = ?').get(requestId);
    if (!row) return null;
    const events = db.prepare('select data from events where request_id = ? order by process, sequence').all(requestId).map(item => JSON.parse(item.data));
    const endings = new Map(events.filter(event => event.type === 'exit' || event.type === 'boundary-end').map(event => [event.id, event]));
    // Values and executed lines, for functions whose detail was asked for.
    const recordedValues = new Map(events.filter(event => event.type === 'detail').map(event => [event.id, event]));
    const starts = events.filter(event => event.type === 'enter' || event.type === 'boundary');
    const ids = new Set(starts.map(event => event.id));
    const depth = new Map();
    // After the response: marked by the capture, or recorded after the
    // request's end in its process (the order inside a process is exact).
    const after = event => Boolean(event.afterResponse)
      || (row.end_sequence != null && event.process === row.process && event.sequence > row.end_sequence);
    const steps = starts.map(event => {
      const level = event.parentId && ids.has(event.parentId) ? (depth.get(event.parentId) ?? 0) + 1 : 0;
      depth.set(event.id, level);
      const end = endings.get(event.id);
      const common = { id: event.id, parentId: event.parentId, depth: level, sequence: event.sequence,
        durationMs: end?.durationNs == null ? null : end.durationNs / 1e6, error: Boolean(end?.error), finished: Boolean(end) };
      if (event.type === 'enter') {
        const detail = recordedValues.get(event.id);
        return { ...common, type: 'function', function: event.function, file: event.file, line: event.line,
          endLine: event.endLine ?? null, mapped: event.mapped, async: event.async,
          opaque: event.opaque || undefined, afterResponse: after(event) || undefined,
          ...(detail ? { detail: { args: detail.args, lines: detail.lines, ...('returned' in detail ? { returned: detail.returned } : { threw: detail.threw }) } } : {}) };
      }
      const { type, id, parentId, requestId: _r, process, sequence, timeNs, version, ...details } = event;
      const { type: _t, id: _i, requestId: _q, durationNs: _d, error: _e, process: _p, sequence: _s, timeNs: _n, version: _v, ...result } = end ?? {};
      const step = { ...common, type: 'boundary', ...details, afterResponse: after(event) || undefined, result };
      if (step.kind === 'ia') step.costUsd = estimateCost(result.model ?? step.model, result.usage);
      return step;
    });
    const limitations = db.prepare('select reason, count(*) as count from limitations where run = ? group by reason order by count desc').all(row.run);
    const runInfo = db.prepare('select root, level, reason from runs where run = ?').get(row.run) ?? {};
    return { request: shapeRequest(row), level: runInfo.level ?? 'normal', reason: runInfo.reason ?? null, root: runInfo.root ?? null,
      steps, marks: marks(steps), limitations };
  }

  // Cost is derived, never recorded: prices come from a local table
  // (.codetac/precos.json: { "modelo": { "entrada": USD/1M, "saida": USD/1M } }).
  function estimateCost(model, usage) {
    const path = join(directory, 'precos.json');
    if (!model || !usage || !existsSync(path)) return null;
    try {
      const price = JSON.parse(readFileSync(path, 'utf8'))[model];
      if (!price) return null;
      return ((usage.input ?? 0) * (price.entrada ?? 0) + (usage.output ?? 0) * (price.saida ?? 0)) / 1e6;
    } catch { return null; }
  }

  // Lasting effects and costs, summarised for the end of the dossier.
  function marks(steps) {
    const result = [];
    const add = (label, key) => {
      const found = result.find(item => item.key === key);
      if (found) found.count++;
      else result.push({ key, label, count: 1 });
    };
    const structure = { commands: 0, tables: new Set() };
    for (const step of steps) {
      if (step.type !== 'boundary') continue;
      if (step.kind === 'base-de-dados' && STRUCTURE.has(step.operation)) {
        structure.commands++;
        for (const table of step.tables ?? []) structure.tables.add(table);
      } else if (step.kind === 'base-de-dados' && WRITES.has(step.operation)) add(`write to ${step.tables?.join(', ') || 'the database'} (${step.operation})`, `db:${step.operation}:${step.tables}`);
      else if (step.kind === 'ia') {
        const model = step.result?.model ?? step.model;
        const usage = step.result?.usage;
        add(`AI call to ${step.provider}${model ? ` (${model})` : ''}${usage ? ` · ${usage.input ?? '?'} + ${usage.output ?? '?'} tokens` : ''}${step.costUsd != null ? ` · ~US$ ${step.costUsd.toFixed(4)}` : ''}`, `ia:${step.id}`);
      }
      else if (step.kind === 'email' || step.kind === 'mensagem') add(`${step.kind === 'email' ? 'email' : 'message'} sent via ${step.provider ?? step.library}`, `mail:${step.provider}`);
      else if (step.kind === 'pagamento') add(`payment ${step.provider} (${display(step.mode)})`, `pay:${step.operation}`);
      else if (step.kind === 'ficheiros' && step.operation !== 'leitura' && step.operation !== 'verificação') add(`file: ${display(step.operation)} on ${step.bucket ?? step.provider}`, `file:${step.operation}:${step.bucket}`);
      else if (step.kind === 'http' && !step.local) add(`external call to ${step.host}`, `http:${step.host}`);
    }
    if (structure.commands) result.push({ key: 'db:structure', count: 1,
      label: `database structure: ${structure.commands} commands (CREATE/ALTER/DROP) on ${structure.tables.size} tables` });
    return result;
  }

  // A file can only be shown if a function from it was recorded in that run.
  const recorded = new Map();
  function recordedFile(run, file) {
    const key = `${run}\n${file}`;
    // Only a positive answer is kept: a file may be recorded later.
    if (recorded.has(key)) return true;
    const found = recordedFileQuery(run, file);
    if (found) recorded.set(key, true);
    return found;
  }
  function recordedFileQuery(run, file) {
    const pattern = `%"file":${JSON.stringify(file)}%`.replace(/[\\_]/g, match => `\\${match}`);
    return Boolean(db.prepare(`select 1 from events e join requests r on r.request_id = e.request_id
      where r.run = ? and e.type = 'enter' and e.data like ? escape '\\' limit 1`).get(run, pattern));
  }

  // The lowest level among the recordings of an action (minimal wins), with its reason.
  function runLevel(runs) {
    const rows = runs.map(run => db.prepare('select level, reason from runs where run = ?').get(run)).filter(Boolean);
    const low = rows.find(row => row.level === 'minimo');
    return { level: low?.level ?? rows[0]?.level ?? 'normal', reason: low?.reason ?? null };
  }

  function root(run) {
    return db.prepare('select root from runs where run = ?').get(run)?.root ?? null;
  }

  // The server's calls to other hosts in a recording (StructureTAC phase 4):
  // host, kind, provider and the names of the fields sent (never values),
  // newest first. Calls to this computer are left out.
  function outgoing(run, { limit = 2000 } = {}) {
    const rows = db.prepare(`select e.process, e.type, e.id, e.data, r.request_id, r.at from events e join requests r on r.request_id = e.request_id
      where r.run = ? and e.type in ('boundary', 'boundary-end') order by r.at desc limit ?`).all(run, limit * 2);
    const ends = new Map(rows.filter(row => row.type === 'boundary-end').map(row => [`${row.process}:${row.id}`, JSON.parse(row.data)]));
    const calls = [];
    for (const row of rows) {
      if (row.type !== 'boundary') continue;
      const data = JSON.parse(row.data);
      if (!data.host || data.local || !['http', 'ia', 'email', 'mensagem', 'pagamento', 'base-de-dados', 'autenticação', 'ficheiros'].includes(data.kind)) continue;
      const end = ends.get(`${row.process}:${row.id}`) ?? {};
      calls.push({ host: data.host, kind: data.kind, provider: data.provider ?? null, method: data.method ?? null, path: data.path ?? null,
        fields: end.fields ?? data.fields ?? null, requestId: row.request_id, at: row.at });
      if (calls.length >= limit) break;
    }
    return calls;
  }

  // Browser positions already resolved to project files, so that a dossier
  // keeps its locations after the application (and its source maps) stops.
  const originGet = db.prepare('select data from origins where key = ?');
  const originSet = db.prepare('insert or replace into origins(key, data) values (?, ?)');
  function cachedOrigin(key) {
    const row = originGet.get(key);
    return row ? JSON.parse(row.data) : null;
  }
  function cacheOrigin(key, value) { originSet.run(key, JSON.stringify(value)); }

  // Answers of the AI model, by prompt: the same function with the same facts
  // is not sent again.
  const purposeGet = db.prepare('select data from purposes where key = ?');
  const purposeSet = db.prepare('insert or replace into purposes(key, data, at) values (?, ?, ?)');
  const purposeCache = {
    get: key => { const row = purposeGet.get(key); return row ? JSON.parse(row.data) : null; },
    set: (key, value) => purposeSet.run(key, JSON.stringify(value), Date.now()),
  };

  return { ingest, listRuns, cachedOrigin, cacheOrigin, purposeCache, listRequests, listActions, actionDossier, dossier, root, outgoing, recordedFile, close: () => db.close() };
}
