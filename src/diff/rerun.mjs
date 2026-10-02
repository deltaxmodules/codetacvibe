// Running an action of the app again after a prompt (phase D6, steps 1 and 2),
// so the Behavior layer has a run after it to compare with the last one before.
// Nothing runs unless the person asks, action by action, in the report.
//
// The recordings never keep a request's input: only its method, its path and
// the names of its query parameters (page.mjs), and that does not change here.
// So CodeTAC runs again only what needs no input: GET and HEAD requests of the
// app's own origin, with no query parameters, in the order they were made. The
// bar sends them from the app's page (the report in its frame asks it), with
// the person's session: from the panel they would go without the cookies. The
// requests carry a new action, with the same page and the same element as the
// original, so the new run is "the same action" (actionKey) and is compared.
//
// Any other action (query parameters, POST, PUT, DELETE, a call to another
// origin, or no request at all) is never run by CodeTAC: the report says how to
// do it again by hand and what it touched the last time it ran.
import { isDevToolRequest } from '../digest.mjs';
import { summarizeAction } from './actions.mjs';

export const RERUN_METHODS = new Set(['GET', 'HEAD']);
const MAX_REQUESTS = 20;
const MAX_PATH = 2000;

// A path the bar may request again: the app's own, with no query, no fragment,
// not one of CodeTAC's (the bar checks the same before sending).
export function replayablePath(path) {
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && path.length <= MAX_PATH
    && !/[?#\\\s]/.test(path) && !/[\u0000-\u001f\u007f]/.test(path) && !path.startsWith('/__codetac/');
}

// The requests of an action, in order, as the server and the browser saw them.
function requestsOf(dossier) {
  const out = [];
  for (const item of dossier.timeline ?? []) {
    if (item.type === 'request') {
      const browser = item.browser ?? {};
      if (!browser.sameOrigin || item.probable) { out.push({ otherOrigin: true, method: browser.method, path: browser.path, host: browser.host }); continue; }
      const server = item.server?.[0]?.request;
      out.push({ method: server?.method ?? browser.method, path: server?.path ?? browser.path, queryKeys: server?.queryKeys ?? browser.queryKeys ?? [] });
    } else if (item.type === 'document' || item.type === 'unmatched') {
      for (const server of item.server ?? []) out.push({ method: server.request?.method, path: server.request?.path, queryKeys: server.request?.queryKeys ?? [] });
    }
  }
  return out.filter(request => !isDevToolRequest(request.path));
}

// What the action touched outside the code the last time (the outside calls
// that matter: writes, services, AI, email, payments, files written).
export function touchedBy(dossier) {
  return [...summarizeAction(dossier).boundaries.values()].filter(item => item.weight === 'warning').map(item => item.text);
}

// How an action can run again: { how: 'rerun', requests, page, trigger } or
// { how: 'by-hand', reason, page }; both with what it touched (touched).
// reason: 'query' (needs the values of its parameters), 'method' (POST, PUT…),
// 'other-origin' (a server on another origin), 'nothing' (no request), 'path'.
export function redoPlan(dossier) {
  const first = (dossier.timeline ?? []).find(item => item.type === 'trigger' || item.page);
  const page = first?.page?.path ?? '/';
  const touched = touchedBy(dossier);
  const byHand = reason => ({ how: 'by-hand', reason, page, touched });
  const requests = requestsOf(dossier);
  if (!requests.length) return byHand('nothing');
  if (requests.some(request => request.otherOrigin)) return byHand('other-origin');
  if (requests.some(request => !RERUN_METHODS.has(String(request.method ?? '').toUpperCase()))) return byHand('method');
  if (requests.some(request => request.queryKeys?.length)) return byHand('query');
  if (requests.length > MAX_REQUESTS || requests.some(request => !replayablePath(request.path))) return byHand('path');
  const element = first?.trigger?.element;
  return {
    how: 'rerun', page, touched,
    requests: requests.map(request => ({ method: String(request.method).toUpperCase(), path: request.path })),
    // The same element and event, so the new run has the same label (actionLabel).
    trigger: element ? { event: first.trigger.event, element } : null,
  };
}
