// Browser side, served by the observed application's own Node server: HTML
// pages get a <script src="/__codetac/bar.js">, and the /__codetac/ routes are
// answered here without ever reaching the application. Works for any server
// built on node:http (Next.js, Vite, Express...), with no proxy or extension.
import { readFileSync } from 'node:fs';
import { splitUrl } from './boundaries.mjs';

export const PREFIX = '/__codetac/';
export const ACTION_HEADER = 'x-codetac-action';
export const INTERNAL_HEADER = 'x-codetac-internal';
const ACTION_ID = /^[A-Za-z0-9_-]{6,40}$/;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_BUFFER = 512 * 1024;
const TAG = '<script src="/__codetac/bar.js" data-codetac=""></script>';

let script = null;
function barScript(options) {
  if (!script) {
    const config = { panel: options.panel, run: options.run };
    script = `window.__CODETAC_CONFIG__=${JSON.stringify(config)};\n${readFileSync(new URL('./browser/bar.js', import.meta.url), 'utf8')}`;
  }
  return script;
}

// Action of an incoming request: the header set by the page script on fetch
// and XHR, or the short cookie it sets before a full page navigation.
export function actionOf(request) {
  const header = request.headers[ACTION_HEADER];
  if (typeof header === 'string') {
    const [id, number] = header.split('.');
    if (ACTION_ID.test(id)) return { action: id, actionRequest: /^\d{1,5}$/.test(number ?? '') ? Number(number) : null };
  }
  if (request.headers['sec-fetch-mode'] === 'navigate') {
    const match = String(request.headers.cookie ?? '').match(/(?:^|;\s*)codetac_action=([A-Za-z0-9_-]{6,40})(?:;|$)/);
    if (match) return { action: match[1], actionRequest: null };
  }
  return null;
}

// Answers /__codetac/ requests. Returns true when the request was handled.
export function handleOwnRoute(request, response, runtime, options) {
  const url = request.url ?? '';
  if (!url.startsWith(PREFIX)) return false;
  const path = url.split('?')[0];
  if (path === `${PREFIX}bar.js` && request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    response.end(barScript(options));
    return true;
  }
  if (path === `${PREFIX}events` && request.method === 'POST') {
    // Only the page itself may report actions: another site open in the
    // browser cannot write into the recording (browsers always send Origin here).
    const origin = request.headers.origin;
    let sameOrigin = !origin;
    try { sameOrigin = sameOrigin || new URL(origin).host === request.headers.host; } catch {}
    if (!sameOrigin) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('CodeTAC: origem recusada.');
      return true;
    }
    let size = 0;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size <= MAX_EVENT_BYTES) chunks.push(chunk);
    });
    request.on('end', () => {
      if (size <= MAX_EVENT_BYTES) {
        try { recordBrowserAction(runtime, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch {}
      }
      response.writeHead(size <= MAX_EVENT_BYTES ? 204 : 413, { 'cache-control': 'no-store' });
      response.end();
    });
    return true;
  }
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('CodeTAC: rota desconhecida.');
  return true;
}

// Only known fields are kept; URLs lose their query values, and everything
// passes through the runtime's redaction before being written.
const text = (value, max = 120) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : undefined;
const number = value => Number.isFinite(value) ? value : undefined;
function frames(list) {
  if (!Array.isArray(list)) return undefined;
  return list.slice(0, 16).map(frame => ({ fn: text(frame?.fn, 80), url: text(frame?.url, 500), line: number(frame?.line), column: number(frame?.column),
    file: text(frame?.file, 500) })).filter(frame => frame.url || frame.file);
}
function names(list) {
  if (!Array.isArray(list)) return undefined;
  return list.slice(0, 40).map(item => ({ name: text(item?.name, 80), count: number(item?.count), frames: frames(item?.frames) })).filter(item => item.name);
}
function pathOf(raw) {
  if (typeof raw !== 'string') return {};
  const { path, queryKeys } = splitUrl(raw);
  return { path, queryKeys };
}
export function recordBrowserAction(runtime, event) {
  if (!event || typeof event !== 'object' || !ACTION_ID.test(String(event.actionId))) return;
  const trigger = event.trigger && typeof event.trigger === 'object' ? event.trigger : null;
  const element = trigger?.element ?? {};
  runtime.emit({
    type: 'browser-action', actionId: event.actionId, segment: number(event.segment) ?? 1,
    origin: text(event.origin, 200), page: pathOf(event.page),
    startedAt: number(event.startedAt), durationMs: number(event.durationMs), closedBy: text(event.closedBy, 40),
    trigger: trigger ? {
      event: text(trigger.event, 20),
      element: { tag: text(element.tag, 20), type: text(element.type, 20), role: text(element.role, 30), text: text(element.text, 80),
        label: text(element.label, 80), name: text(element.name, 60), id: text(element.id, 60), href: element.href ? pathOf(element.href).path : undefined },
      component: trigger.component ? { name: text(trigger.component.name, 80), owners: Array.isArray(trigger.component.owners)
        ? trigger.component.owners.slice(0, 6).map(owner => ({ name: text(owner?.name, 80), frames: frames(owner?.frames) })).filter(owner => owner.name) : undefined,
        frames: frames(trigger.component.frames) } : undefined,
      handler: trigger.handler ? { name: text(trigger.handler.name, 80), prop: text(trigger.handler.prop, 30), source: text(trigger.handler.source, 20) } : undefined,
    } : undefined,
    requests: Array.isArray(event.requests) ? event.requests.slice(0, 200).map(item => ({
      n: number(item?.n), kind: text(item?.kind, 20), method: text(item?.method, 10), ...pathOf(item?.url),
      sameOrigin: Boolean(item?.sameOrigin), host: item?.sameOrigin ? undefined : text(item?.host, 200),
      startMs: number(item?.startMs), durationMs: number(item?.durationMs), status: number(item?.status), error: Boolean(item?.error) || undefined,
      frames: frames(item?.frames) })) : [],
    screen: event.screen && typeof event.screen === 'object' ? {
      added: number(event.screen.added), removed: number(event.screen.removed), text: number(event.screen.text),
      attributes: number(event.screen.attributes), title: Boolean(event.screen.title) || undefined,
      stateChanged: names(event.screen.stateChanged), mounted: names(event.screen.mounted), unmounted: names(event.screen.unmounted) } : undefined,
    scripts: Array.isArray(event.scripts) ? event.scripts.slice(0, 80).map(url => text(url, 500)).filter(Boolean) : undefined,
    navigations: Array.isArray(event.navigations) ? event.navigations.slice(0, 20).map(item => ({ kind: text(item?.kind, 20), ...pathOf(item?.to), atMs: number(item?.atMs) })) : undefined,
  });
}

// Top-level HTML documents get the script tag. The response is not
// compressed (accept-encoding is removed for these requests only), and its
// length and validators are dropped because the body changes.
export function wantsPage(request) {
  if (request.method !== 'GET' || request.headers[INTERNAL_HEADER]) return false;
  const destination = request.headers['sec-fetch-dest'];
  if (destination) return destination === 'document';
  return /text\/html/.test(String(request.headers.accept ?? ''));
}

function headerIn(headers, name) {
  if (!headers) return undefined;
  if (Array.isArray(headers)) {
    for (let i = 0; i + 1 < headers.length; i += 2) if (String(headers[i]).toLowerCase() === name) return headers[i + 1];
    return undefined;
  }
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value;
  return undefined;
}
const DROP = new Set(['content-length', 'etag', 'last-modified']);
function withoutLength(headers) {
  if (Array.isArray(headers)) {
    const result = [];
    for (let i = 0; i + 1 < headers.length; i += 2) if (!DROP.has(String(headers[i]).toLowerCase())) result.push(headers[i], headers[i + 1]);
    return result;
  }
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !DROP.has(key.toLowerCase())));
}

export function injectScript(request, response) {
  delete request.headers['accept-encoding'];
  let mode = null; // null: undecided; 'pass'; 'buffer'; 'done'
  const chunks = [];
  const { writeHead, write, end } = response;

  response.writeHead = function codetacWriteHead(status, ...rest) {
    if (mode === null) {
      const reason = typeof rest[0] === 'string' ? [rest[0]] : [];
      let headers = typeof rest[0] === 'string' ? rest[1] : rest[0];
      const type = headerIn(headers, 'content-type') ?? this.getHeader('content-type');
      const encoding = headerIn(headers, 'content-encoding') ?? this.getHeader('content-encoding');
      // Error pages too (Phase 5): an application that fails still gets the
      // bar, and the failing load has its dossier.
      mode = status >= 200 && status < 600 && status !== 204 && status !== 304 && /text\/html/i.test(String(type ?? '')) && !encoding ? 'buffer' : 'pass';
      if (mode === 'buffer') {
        for (const name of DROP) this.removeHeader(name);
        if (headers) rest = [...reason, withoutLength(headers)];
      }
    }
    return writeHead.call(this, status, ...rest);
  };
  const decide = self => { if (mode === null && !self.headersSent) self.writeHead(self.statusCode); if (mode === null) mode = 'pass'; };
  const toBuffer = (chunk, encoding) => Buffer.isBuffer(chunk) ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk)
    : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
  // Inserts the tag after <head ...>, or before <body> when there is no head.
  // Fragments (no head/body, as in partial HTML responses) are left intact.
  function take(final) {
    const all = Buffer.concat(chunks);
    const view = all.toString('latin1');
    const head = view.match(/<head(?:\s[^>]*)?>/i);
    let at = head ? head.index + head[0].length : -1;
    if (at < 0 && (final || all.length > MAX_BUFFER)) at = view.search(/<body[\s>]/i);
    if (at < 0) return final || all.length > MAX_BUFFER ? all : null;
    return Buffer.concat([all.subarray(0, at), Buffer.from(TAG), all.subarray(at)]);
  }

  response.write = function codetacWrite(chunk, encoding, callback) {
    decide(this);
    if (mode !== 'buffer') return write.apply(this, arguments);
    if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    const buffer = toBuffer(chunk, encoding);
    chunks.push(buffer);
    const output = take(false);
    if (output) { mode = 'done'; return write.call(this, output, callback); }
    if (callback) process.nextTick(callback);
    return true;
  };
  response.end = function codetacEnd(chunk, encoding, callback) {
    if (typeof chunk === 'function') { callback = chunk; chunk = undefined; }
    else if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    decide(this);
    if (mode !== 'buffer') return chunk == null ? end.call(this, callback) : end.call(this, chunk, encoding, callback);
    if (chunk != null) chunks.push(toBuffer(chunk, encoding));
    mode = 'done';
    return end.call(this, take(true), callback);
  };
}

export function panelUrl() {
  return process.env.CODETAC_PANEL_URL || `http://127.0.0.1:${process.env.CODETAC_PANEL_PORT || 4000}`;
}
