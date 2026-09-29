// CodeTAC page script, injected by the observed Node server into HTML pages.
// It records user actions (click or submit): the element, the component and
// the handler, the requests that followed (each marked with the action id),
// and what changed on screen. It does not trace browser functions one by one.
// Everything the page does is left as it was: the originals are always called.
(() => {
  'use strict';
  if (window.__codetacPage) return;
  window.__codetacPage = true;
  const config = window.__CODETAC_CONFIG__ || {};
  // The Structure sentences, from src/structure/text/<language>.json (sent with
  // the config), escaped for the markup they go into.
  const barText = key => String((config.text || {})[key] ?? key).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ENDPOINT = '/__codetac/events';
  const HEADER = 'x-codetac-action';
  const COOKIE = 'codetac_action';
  const QUIET_MS = 600;
  const MAX_MS = 15000;
  const originalFetch = window.fetch;
  const now = () => performance.now();
  let host = null;          // the bar's element, excluded from everything observed
  let current = null;       // newest open action: new requests and screen changes go to it
  const open = new Set();
  const recorded = [];      // actions sent from this page, for the bar

  // ---------------------------------------------------------------------------
  // Stacks (only positions in scripts, resolved later by the panel)
  // ---------------------------------------------------------------------------
  // Numeric cache-busting parameters (Vite's ?t=, Next's ?v=) look like phone
  // numbers to the redaction; the scripts are served without them too.
  function withoutCacheBusters(url) {
    return url.replace(/([?&])[\w-]+=\d{8,}(?=&|$)/g, '$1').replace(/\?&+/, '?').replace(/&&+/g, '&').replace(/[?&]$/, '');
  }
  function parseStack(stack) {
    const frames = [];
    for (const line of String(stack || '').split('\n')) {
      let match = line.match(/^\s*at (?:async )?(.*?) \((.*):(\d+):(\d+)\)\s*$/) || line.match(/^\s*at (?:async )?()(.*):(\d+):(\d+)\s*$/)
        || line.match(/^(.*?)@(.*):(\d+):(\d+)$/);
      if (!match) continue;
      const url = withoutCacheBusters(match[2]);
      if (url.includes('/__codetac/') || !/^(https?|webpack-internal):/.test(url)) continue;
      // "HTMLButtonElement.saveNote", "Object.onClick": the receiver is not part of the name.
      const fn = (match[1] || '').replace(/^(?:[\w$]+\.)+(?=[\w$]+$)/, '') || undefined;
      frames.push({ fn, url, line: Number(match[3]), column: Number(match[4]) });
      if (frames.length >= 16) break;
    }
    return frames;
  }
  function stackHere() {
    const limit = Error.stackTraceLimit;
    try { Error.stackTraceLimit = 40; } catch {}
    const stack = new Error().stack;
    try { Error.stackTraceLimit = limit; } catch {}
    return parseStack(stack);
  }

  // ---------------------------------------------------------------------------
  // Element, component and handler
  // ---------------------------------------------------------------------------
  const INTERACTIVE = 'a[href],button,input,select,textarea,label,summary,[role=button],[role=link],[role=menuitem],[role=tab],[role=checkbox],[role=switch],[role=option],[onclick],[contenteditable=""],[contenteditable=true]';
  const clean = (value, max = 80) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : undefined;
  function describeElement(element) {
    const tag = element.tagName.toLowerCase();
    const type = element.getAttribute('type') || undefined;
    // Never the value of a field: only what identifies it on screen.
    const isField = tag === 'input' || tag === 'textarea' || tag === 'select';
    const label = element.getAttribute('aria-label') || element.getAttribute('title')
      || (isField ? element.getAttribute('placeholder') || element.labels?.[0]?.textContent : undefined);
    let text = isField || tag === 'form' ? undefined : element.innerText || element.textContent;
    if (isField && (type === 'submit' || type === 'button')) text = element.value;
    return { tag, type, role: element.getAttribute('role') || undefined, text: clean(text), label: clean(label),
      name: element.getAttribute('name') || undefined, id: element.id || undefined,
      href: tag === 'a' ? element.getAttribute('href') || undefined : undefined };
  }
  function reactKey(node, prefix) {
    for (const key in node) if (key.startsWith(prefix)) return node[key];
    return undefined;
  }
  function componentName(fiber) {
    const type = fiber && (fiber.type || fiber.elementType);
    if (!type) return fiber && typeof fiber.name === 'string' ? fiber.name : undefined;
    if (typeof type === 'function') return type.displayName || type.name || undefined;
    if (typeof type === 'object') {
      return type.displayName || (type.render && (type.render.displayName || type.render.name))
        || (type.type && (type.type.displayName || type.type.name)) || undefined;
    }
    return undefined;
  }
  function isComposite(fiber) {
    return fiber && (typeof fiber.type === 'function' || (fiber.type && typeof fiber.type === 'object' && (fiber.type.render || fiber.type.type)));
  }
  function creationFrames(fiber) {
    // React 19 (development): the stack where the element was created, i.e.
    // the JSX line inside its component. React 18: _debugSource.
    // Only the frames above React's marker belong to the owner's render.
    if (fiber && fiber._debugStack) {
      const stack = String(fiber._debugStack.stack || '');
      const bottom = stack.search(/react[-_]stack[-_]bottom[-_]frame/);
      return parseStack(bottom >= 0 ? stack.slice(0, stack.lastIndexOf('\n', bottom)) : stack).slice(0, 8);
    }
    const source = fiber && fiber._debugSource;
    if (source && source.fileName) return [{ file: source.fileName, line: source.lineNumber, column: source.columnNumber }];
    return undefined;
  }
  // React 19 form actions (<form action={fn}>, <button formAction={fn}>) count as submit handlers.
  const HANDLERS = { click: ['onClick', 'onClickCapture', 'onMouseDown', 'onMouseUp', 'onPointerDown', 'onPointerUp'], submit: ['onSubmit', 'onSubmitCapture', 'action', 'formAction'] };
  function reactTrigger(target, kind) {
    for (let element = target; element && element !== document.documentElement; element = element.parentElement) {
      const fiber = reactKey(element, '__reactFiber$');
      if (!fiber) continue;
      const props = fiber.memoizedProps || {};
      const prop = HANDLERS[kind].find(name => typeof props[name] === 'function');
      if (!prop) continue;
      let owner = fiber._debugOwner;
      if (!owner) { owner = fiber.return; while (owner && !isComposite(owner)) owner = owner.return; }
      // An inline function takes the name of the prop it was written in.
      const name = handlerName(props[prop]);
      return { element, handler: { name: name === prop ? '(inline function)' : name, prop, source: 'react' },
        component: componentOf(fiber, owner) };
    }
    return null;
  }
  // The component that rendered the element, and the components that rendered
  // it in turn (each with where it was written), so that the panel can name the
  // first one from the project when the element comes from a library.
  function componentOf(fiber, owner) {
    const owners = [];
    for (let item = owner; item && owners.length < 6; item = item._debugOwner || null) {
      const name = componentName(item);
      if (name) owners.push({ name, frames: creationFrames(item) });
    }
    return { name: componentName(owner), frames: creationFrames(fiber), owners: owners.slice(1) };
  }
  function handlerName(fn) {
    const name = String(fn && fn.name || '').replace(/^bound /, '');
    return name || '(anonymous function)';
  }
  // Listeners added with addEventListener are remembered by element and type,
  // only their names, so a non-React page can still name the handler.
  const listeners = new WeakMap();
  const addEventListener = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    try {
      if (listener && (type === 'click' || type === 'submit') && this instanceof Element) {
        const list = listeners.get(this) || [];
        if (list.length < 20) list.push({ type, name: handlerName(typeof listener === 'function' ? listener : listener.handleEvent) });
        listeners.set(this, list);
      }
    } catch {}
    return addEventListener.call(this, type, listener, options);
  };
  function domTrigger(target, kind) {
    for (let element = target; element && element !== document.documentElement; element = element.parentElement) {
      // Page-wide listeners (on <body>, or React's own on its root container)
      // are not the handler of the element that was clicked.
      if (element === document.body || element._reactRootContainer || reactKey(element, '__reactContainer$')) break;
      const inline = kind === 'click' ? element.onclick : element.onsubmit;
      if (typeof inline === 'function') return { element, handler: { name: element.hasAttribute('on' + kind) ? '(on' + kind + ' attribute)' : handlerName(inline), source: 'dom' } };
      const found = (listeners.get(element) || []).find(item => item.type === kind);
      if (found) return { element, handler: { name: found.name, source: 'dom' } };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  const randomId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  function newAction(id, segment, trigger) {
    const action = { id, segment, trigger, page: location.pathname + location.search, startedAt: Date.now(), start: now(), last: now(), requests: [], pending: 0, next: (segment - 1) * 1000 + 1,
      screen: { added: 0, removed: 0, text: 0, attributes: 0, title: false, stateChanged: new Map(), mounted: new Map(), unmounted: new Map() },
      navigations: [], element: null, timer: null, closed: false };
    open.add(action);
    current = action;
    schedule(action);
    return action;
  }
  function touch(action) { action.last = now(); schedule(action); }
  function schedule(action) {
    clearTimeout(action.timer);
    action.timer = setTimeout(() => check(action), QUIET_MS);
  }
  function check(action) {
    if (action.closed) return;
    if (now() - action.start > MAX_MS) return close(action, 'time limit');
    if (action.pending > 0 || now() - action.last < QUIET_MS) return schedule(action);
    close(action, 'idle');
  }
  function listOf(map) {
    return [...map.values()].slice(0, 40).map(item => ({ name: item.name, count: item.count, frames: item.frames }));
  }
  function payload(action, closedBy) {
    const s = action.screen;
    return { actionId: action.id, segment: action.segment, origin: location.origin, page: action.page,
      startedAt: action.startedAt, durationMs: Math.round(now() - action.start), closedBy, trigger: action.trigger,
      requests: action.requests.map(({ n, kind, method, url, sameOrigin, host: domain, startMs, durationMs, status, error, frames }) =>
        ({ n, kind, method, url, sameOrigin, host: domain, startMs, durationMs, status, error, frames })),
      screen: { added: s.added, removed: s.removed, text: s.text, attributes: s.attributes, title: s.title,
        stateChanged: listOf(s.stateChanged), mounted: listOf(s.mounted), unmounted: listOf(s.unmounted) },
      navigations: action.navigations, scripts: pageScripts() };
  }
  // Scripts of this page, so that positions inside code evaluated from
  // strings (webpack "eval" modes) can be found by the panel.
  function pageScripts() {
    const urls = new Set();
    try {
      for (const script of document.scripts) if (script.src) urls.add(script.src);
      for (const entry of performance.getEntriesByType('resource')) if (entry.initiatorType === 'script') urls.add(entry.name);
    } catch {}
    return [...urls].filter(url => url.startsWith(location.origin + '/') && !url.includes('/__codetac/')).map(withoutCacheBusters).slice(0, 80);
  }
  function close(action, closedBy, leaving) {
    if (action.closed) return;
    action.closed = true;
    clearTimeout(action.timer);
    open.delete(action);
    if (current === action) current = null;
    if (!leaving) clearCookie();
    const body = JSON.stringify(payload(action, closedBy));
    try {
      if (leaving && navigator.sendBeacon) navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'text/plain' }));
      else originalFetch.call(window, ENDPOINT, { method: 'POST', body, keepalive: body.length < 60000, headers: { 'content-type': 'text/plain' } }).catch(() => {});
    } catch {}
    // A continuation on a new page counts too: in server-rendered apps (a form
    // that loads the next page) it is how the bar shows what brought you here.
    if (action.trigger || action.requests.length || action.segment > 1) {
      recorded.push({ id: action.id, label: labelOf(action), requests: action.requests.length, closedBy });
      if (recorded.length > 30) recorded.shift();
      updateBar(true);
    }
  }
  function labelOf(action) {
    const element = action.trigger && action.trigger.element;
    if (!element) return action.continues ? action.continues + ' (continued)' : 'continuation after navigation';
    const kinds = { a: 'link', button: 'button', input: 'field', select: 'list', textarea: 'text box', label: 'label', summary: 'section', form: 'form' };
    const kind = element.role === 'button' || (element.tag === 'input' && /submit|button/.test(element.type || '')) ? 'button' : kinds[element.tag] || element.tag;
    const text = element.text || element.label || element.name || element.id;
    return kind + (text ? ' “' + text + '”' : '');
  }
  // Navigations that load a new document carry the action in a short cookie;
  // the new page continues the same action until it is quiet.
  function setCookie(id) { document.cookie = COOKIE + '=' + id + '; path=/; max-age=15; samesite=lax'; }
  function clearCookie() { if (document.cookie.includes(COOKIE + '=')) document.cookie = COOKIE + '=; path=/; max-age=0; samesite=lax'; }
  function continued() {
    const match = document.cookie.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([A-Za-z0-9_-]{6,40})'));
    if (!match) return;
    clearCookie();
    let segment = 2;
    try { segment = Number(sessionStorage.getItem('codetac:segment:' + match[1]) || 1) + 1; sessionStorage.setItem('codetac:segment:' + match[1], String(segment)); } catch {}
    const action = newAction(match[1], segment, null);
    action.navigations.push({ kind: 'document', to: location.pathname + location.search, atMs: 0 });
    try { action.continues = sessionStorage.getItem('codetac:label:' + match[1]); } catch {}
  }

  // Clicking into a text field only focuses it; typing is not an action.
  const TEXT_INPUT = /^(text|email|password|search|tel|url|number|date|datetime-local|month|week|time|color)?$/;
  function onlyFocus(element) {
    const tag = element.tagName;
    return tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable
      || (tag === 'INPUT' && TEXT_INPUT.test((element.getAttribute('type') || '').toLowerCase()));
  }
  // One gesture can produce several events: a click on a submit button is
  // followed by the form's submit, and a click on a label by a click on its
  // field. They join the action of the first event instead of opening another.
  function sameGesture(event, kind, target) {
    const action = current;
    if (!action || action.closed || !action.element || now() - action.start > 1000) return null;
    if (kind === 'submit') {
      const submitter = event.submitter;
      return submitter && (submitter === action.element || submitter.contains(action.element) || action.element.contains(submitter)) ? action : null;
    }
    if (kind === 'click' && action.element.tagName === 'LABEL' && action.element.control === target && now() - action.start < 100) return action;
    return null;
  }
  function onUserEvent(event) {
    const target = event.target;
    if (!(target instanceof Element) || (host && (target === host || host.contains(target)))) return;
    const kind = event.type === 'submit' ? 'submit' : event.type === 'change' ? 'change' : 'click';
    if (kind === 'change' && !(target.tagName === 'SELECT' || (target.tagName === 'INPUT' && /^(file|range)$/i.test(target.type)))) return;
    const joined = sameGesture(event, kind, target);
    if (joined) {
      if (kind === 'submit') {
        const found = reactTrigger(target, 'submit') || domTrigger(target, 'submit');
        if (found && !joined.trigger.handler) joined.trigger.handler = found.handler;
        else if (found) joined.trigger.submit = { handler: found.handler };
      }
      return;
    }
    const lookup = kind === 'change' ? 'click' : kind;
    const found = kind === 'change' ? null : reactTrigger(target, lookup) || domTrigger(target, lookup);
    // The element is the interactive one that was clicked; a handler found on
    // an ancestor (event delegation) does not replace it.
    const element = kind === 'click' ? target.closest(INTERACTIVE) || (found && found.element) : target;
    if (!element || (kind === 'click' && onlyFocus(element) && !(found && found.element === element))) return;
    const trigger = { event: kind, element: describeElement(element), handler: found ? found.handler : undefined,
      component: found ? found.component : undefined };
    if (kind === 'change') {
      const fiber = reactKey(element, '__reactFiber$');
      const props = (fiber && fiber.memoizedProps) || {};
      if (typeof props.onChange === 'function') trigger.handler = { name: handlerName(props.onChange) === 'onChange' ? '(inline function)' : handlerName(props.onChange), prop: 'onChange', source: 'react' };
    }
    if (!trigger.component) {
      const fiber = reactKey(element, '__reactFiber$');
      if (fiber) {
        let owner = fiber._debugOwner;
        if (!owner) { owner = fiber.return; while (owner && !isComposite(owner)) owner = owner.return; }
        trigger.component = componentOf(fiber, owner);
      }
    }
    const action = newAction(randomId(), 1, trigger);
    action.element = element;
    try {
      sessionStorage.setItem('codetac:segment:' + action.id, '1');
      sessionStorage.setItem('codetac:label:' + action.id, labelOf(action));
    } catch {}
    setCookie(action.id);
  }
  addEventListener.call(window, 'click', onUserEvent, true);
  addEventListener.call(window, 'submit', onUserEvent, true);
  addEventListener.call(window, 'change', onUserEvent, true);
  addEventListener.call(window, 'pagehide', () => {
    for (const action of [...open]) {
      action.navigations.push({ kind: 'page exit', to: location.pathname, atMs: Math.round(now() - action.start) });
      close(action, 'navigation', true);
    }
  });

  // ---------------------------------------------------------------------------
  // Requests
  // ---------------------------------------------------------------------------
  function track(kind, method, rawUrl) {
    const action = current;
    if (!action || action.closed) return null;
    let url;
    try { url = new URL(rawUrl, location.href); } catch { return null; }
    if (url.pathname.startsWith('/__codetac/') && url.origin === location.origin) return null;
    const sameOrigin = url.origin === location.origin;
    const entry = { n: action.next++, kind, method: String(method || 'GET').toUpperCase(), url: url.href, sameOrigin,
      host: sameOrigin ? undefined : url.host, startMs: Math.round(now() - action.start), frames: stackHere(), started: now() };
    action.requests.push(entry);
    action.pending++;
    touch(action);
    return { action, entry, header: sameOrigin ? action.id + '.' + entry.n : null };
  }
  function done(tracked, status, error) {
    if (!tracked) return;
    tracked.entry.durationMs = Math.round(now() - tracked.entry.started);
    tracked.entry.status = status;
    tracked.entry.error = error || undefined;
    tracked.action.pending--;
    touch(tracked.action);
  }
  if (typeof originalFetch === 'function') {
    window.fetch = function fetch(input, init) {
      let tracked = null;
      try {
        const isRequest = typeof Request !== 'undefined' && input instanceof Request;
        tracked = track('fetch', (init && init.method) || (isRequest ? input.method : 'GET'), isRequest ? input.url : String(input));
        if (tracked && tracked.header) {
          const headers = new Headers((init && init.headers) || (isRequest ? input.headers : undefined));
          headers.set(HEADER, tracked.header);
          init = Object.assign({}, init, { headers });
        }
      } catch { tracked = null; }
      const result = originalFetch.call(this, input, init);
      if (tracked) result.then(response => done(tracked, response.status, false), () => done(tracked, undefined, true));
      return result;
    };
  }
  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__codetac = { method, url };
    return xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const info = this.__codetac;
    let tracked = null;
    try {
      tracked = info ? track('xhr', info.method, info.url) : null;
      if (tracked && tracked.header) this.setRequestHeader(HEADER, tracked.header);
      if (tracked) addEventListener.call(this, 'loadend', () => done(tracked, this.status || undefined, !this.status));
    } catch {}
    return xhrSend.apply(this, arguments);
  };

  // ---------------------------------------------------------------------------
  // Screen: DOM changes, React state changes, navigation
  // ---------------------------------------------------------------------------
  function outsideBar(node) { return !host || (node !== host && !host.contains(node)); }
  const observer = new MutationObserver(records => {
    const action = current;
    if (!action || action.closed) return;
    let counted = false;
    for (const record of records) {
      if (!outsideBar(record.target)) continue;
      counted = true;
      if (record.type === 'childList') {
        action.screen.added += record.addedNodes.length;
        action.screen.removed += record.removedNodes.length;
        if (record.target.nodeName === 'TITLE') action.screen.title = true;
      } else if (record.type === 'characterData') action.screen.text++;
      else action.screen.attributes++;
    }
    if (counted) touch(action);
  });
  observer.observe(document, { childList: true, subtree: true, characterData: true, attributes: true });

  // React reports each commit to the DevTools hook. An existing hook (the
  // extension, React Refresh) is kept and chained; otherwise a minimal one is
  // defined, with the same shape React Refresh uses.
  // A component is placed where it is written: the elements it returns are
  // created inside its own render, so their position is its own file. (Where
  // it is used may be a framework's router.)
  function count(map, fiber) {
    const name = componentName(fiber);
    if (!name) return;
    const item = map.get(name);
    if (item) item.count++;
    else if (map.size < 40) map.set(name, { name, count: 1, frames: (fiber.child && fiber.child._debugOwner === fiber && creationFrames(fiber.child)) || creationFrames(fiber) });
  }
  // A state change is a useState/useReducer value (or a class state object)
  // that differs from the previous commit, not a mere re-render.
  function changedState(fiber, previous) {
    if (fiber.tag === 1) return fiber.memoizedState !== previous.memoizedState;
    let hook = fiber.memoizedState;
    let old = previous.memoizedState;
    for (let guard = 0; hook && old && typeof hook === 'object' && guard < 200; guard++) {
      if (hook.queue && typeof hook.queue.dispatch === 'function' && !Object.is(hook.memoizedState, old.memoizedState)) return true;
      hook = hook.next;
      old = old.next;
    }
    return false;
  }
  // Only subtrees touched by this commit are visited: an untouched subtree
  // keeps the very same child fiber as before (the check React DevTools uses).
  function onCommit(root) {
    const action = current;
    if (!action || action.closed || !root || !root.current) return;
    let seen = 0;
    const stack = [root.current];
    while (stack.length && seen < 20000) {
      const fiber = stack.pop();
      seen++;
      const previous = fiber.alternate;
      if (isComposite(fiber)) {
        if (!previous) count(action.screen.mounted, fiber);
        else if (changedState(fiber, previous)) count(action.screen.stateChanged, fiber);
      }
      if (!previous || fiber.child !== previous.child) {
        for (let child = fiber.child; child; child = child.sibling) stack.push(child);
      }
    }
    touch(action);
  }
  function onUnmount(fiber) {
    const action = current;
    if (action && !action.closed && isComposite(fiber)) count(action.screen.unmounted, fiber);
  }
  try {
    let hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook) {
      let nextId = 1;
      hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { renderers: new Map(), supportsFiber: true,
        inject(renderer) { const id = nextId++; this.renderers.set(id, renderer); return id; },
        onScheduleFiberRoot() {}, onCommitFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {} };
    }
    const commit = hook.onCommitFiberRoot;
    hook.onCommitFiberRoot = function (id, root) {
      try { onCommit(root); } catch {}
      return typeof commit === 'function' ? commit.apply(this, arguments) : undefined;
    };
    const unmount = hook.onCommitFiberUnmount;
    hook.onCommitFiberUnmount = function (id, fiber) {
      try { onUnmount(fiber); } catch {}
      return typeof unmount === 'function' ? unmount.apply(this, arguments) : undefined;
    };
  } catch {}

  for (const name of ['pushState', 'replaceState']) {
    const original = history[name];
    history[name] = function () {
      const result = original.apply(this, arguments);
      try {
        const action = current;
        if (action && !action.closed) {
          action.navigations.push({ kind: name === 'pushState' ? 'address changed' : 'address replaced', to: location.pathname + location.search, atMs: Math.round(now() - action.start) });
          touch(action);
        }
      } catch {}
      return result;
    };
  }
  addEventListener.call(window, 'popstate', () => {
    if (!current || current.closed) return;
    // A link to a fragment (#section, or a hash router) also fires popstate:
    // it is not the back/forward buttons. Only short, plain fragments are
    // shown (an access token can travel in the fragment).
    // The same when the code of the click changes location.hash: the back
    // button makes no click in the page, so a popstate right after one is
    // the page's own doing.
    const anchor = current.element && current.element.closest && current.element.closest('a[href]');
    const byPage = now() - current.start < 1000;
    const hash = byPage && /^#[\w\/-]{1,40}$/.test(location.hash) ? location.hash : '';
    const kind = !byPage ? 'back/forward' : anchor && anchor.hash ? 'in-page link' : 'address changed';
    current.navigations.push({ kind, to: location.pathname + location.search + hash, atMs: Math.round(now() - current.start) });
  });

  // ---------------------------------------------------------------------------
  // Bar: a small closed shadow root, fixed in a corner, outside the page's layout.
  // ---------------------------------------------------------------------------
  let shadow = null;
  let shown = null;
  // The sheet has two views: the dossier of an action, and the project's structure.
  let view = 'action';
  function mountBar() {
    if (host || !document.documentElement) return;
    host = document.createElement('codetac-bar');
    host.setAttribute('style', 'all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647;display:block;');
    shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<style>' +
      ':host{all:initial}*{box-sizing:border-box;font:12px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif}' +
      '.pill{display:flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;background:rgba(24,24,27,.82);color:#f4f4f5;border:0;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.25);max-width:280px}' +
      '.pill:hover{background:rgba(24,24,27,.95)}.dot{width:8px;height:8px;border-radius:50%;background:#71717a;flex:none}.dot.on{background:#22c55e}' +
      '.flash .dot{animation:f 1s ease-out}@keyframes f{0%{transform:scale(1.8);background:#4ade80}100%{transform:scale(1)}}' +
      '.label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.row{display:flex;gap:6px;justify-content:flex-end}' +
      '.sheet{position:fixed;right:12px;bottom:48px;width:min(760px,calc(100vw - 24px));height:min(640px,calc(100vh - 72px));background:#fff;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.3);display:flex;flex-direction:column;overflow:hidden}' +
      '.top{display:flex;gap:6px;align-items:center;padding:6px 8px;background:#18181b;color:#f4f4f5}.top b{margin-right:auto}' +
      '.top button,.top a{all:unset;cursor:pointer;padding:2px 8px;border-radius:5px;color:#e4e4e7}.top button:hover,.top a:hover{background:#3f3f46}' +
      '.top .tab{color:#a1a1aa}.top .tab.on{background:#3f3f46;color:#fff}.sheet.wide{width:min(1100px,calc(100vw - 24px));height:min(760px,calc(100vh - 72px))}' +
      'iframe{border:0;flex:1;width:100%}.msg{padding:16px;color:#27272a}</style>' +
      '<div class="row"><button class="pill structure" part="structure" title="' + barText('structureTitle') + '">' + barText('structure') + '</button>' +
      '<button class="pill main" part="pill" title="CodeTAC: click to see the dossier of the last action"><span class="dot"></span><span class="label">CodeTAC</span></button></div>';
    shadow.querySelector('.pill.main').addEventListener('click', () => { if (shown && view === 'structure') { view = 'action'; shown.remove(); shown = null; } toggleSheet(); });
    shadow.querySelector('.pill.structure').addEventListener('click', () => {
      if (shown && view === 'structure') { shown.remove(); shown = null; return; }
      showStructure();
    });
    document.documentElement.appendChild(host);
    updateBar(false);
  }
  function updateBar(flash) {
    if (!shadow) return;
    const pill = shadow.querySelector('.pill.main');
    const last = recorded[recorded.length - 1];
    shadow.querySelector('.dot').classList.toggle('on', Boolean(last));
    shadow.querySelector('.label').textContent = last ? 'Recorded: ' + last.label : 'CodeTAC';
    if (flash) { pill.classList.remove('flash'); void pill.offsetWidth; pill.classList.add('flash'); }
    if (shown && flash && view === 'action') showAction(recorded.length - 1);
    // With the plan open, a new action lights up its path.
    if (shown && flash && view === 'structure') showStructure();
  }
  // Action / Structure tabs at the start of the sheet's top line.
  function tabs() {
    return '<button class="tab' + (view === 'action' ? ' on' : '') + '" data-tab="action" title="' + barText('actionTabTitle') + '">' + barText('actionTab') + '</button>' +
      '<button class="tab' + (view === 'structure' ? ' on' : '') + '" data-tab="structure" title="' + barText('structureTabTitle') + '">' + barText('structure') + '</button>';
  }
  function wireTabs() {
    for (const button of shown.querySelectorAll('[data-tab]')) {
      button.addEventListener('click', () => {
        if (button.dataset.tab === view) return;
        view = button.dataset.tab;
        if (view === 'structure') showStructure();
        else if (recorded.length) showAction(recorded.length - 1);
        else { shown.remove(); shown = null; toggleSheet(); }
      });
    }
  }
  function sheet() {
    if (!shown) {
      shown = document.createElement('div');
      shown.className = 'sheet';
      shadow.appendChild(shown);
    }
    shown.classList.toggle('wide', view === 'structure');
    shown.style.height = '';
    return shown;
  }
  function panelMissing(panel) {
    // The panel runs separately; without it the frame would stay blank.
    originalFetch.call(window, panel + '/api/ping', { mode: 'no-cors', cache: 'no-store' }).catch(() => {
      if (!shown) return;
      const frame = shown.querySelector('iframe');
      if (!frame) return;
      const message = document.createElement('div');
      message.className = 'msg';
      message.textContent = 'The CodeTAC panel is not running. Stop the app (Ctrl+C) and run codetac again.';
      frame.replaceWith(message);
    });
  }
  function showStructure() {
    view = 'structure';
    const panel = String(config.panel || 'http://127.0.0.1:4000').replace(/\/$/, '');
    const last = recorded[recorded.length - 1];
    const query = 'run=' + encodeURIComponent(config.run || '') + (last ? '&action=' + encodeURIComponent(last.id) : '');
    sheet().innerHTML = '<div class="top">' + tabs() + '<b></b><a target="_blank" rel="noopener" title="' + barText('openPanelTitle') + '">' + barText('openPanel') + '</a><button data-close title="' + barText('close') + '">✕</button></div>' +
      '<iframe title="' + barText('frameTitle') + '"></iframe>';
    shown.querySelector('a').href = panel + '/structure?' + query;
    shown.querySelector('iframe').src = panel + '/structure?embed=1&' + query;
    shown.querySelector('[data-close]').addEventListener('click', () => { shown.remove(); shown = null; });
    wireTabs();
    panelMissing(panel);
  }
  function toggleSheet() {
    if (shown) { shown.remove(); shown = null; return; }
    if (view === 'structure') { showStructure(); return; }
    if (recorded.length) { showAction(recorded.length - 1); return; }
    // Nothing recorded on this page yet: say so instead of doing nothing.
    const panel = String(config.panel || 'http://127.0.0.1:4000').replace(/\/$/, '');
    sheet().style.height = 'auto';
    shown.innerHTML = '<div class="top">' + tabs() + '<b></b><a target="_blank" rel="noopener">panel ↗</a><button data-close title="Close">✕</button></div>' +
      '<div class="msg">No actions recorded on this page yet. Click a button, submit a form or follow a link in the app: ' +
      'the action shows up here. Actions from other pages are in the panel.</div>';
    shown.querySelector('a').href = panel + '/';
    shown.querySelector('[data-close]').addEventListener('click', () => { shown.remove(); shown = null; });
    wireTabs();
  }
  function showAction(index) {
    const item = recorded[index];
    if (!item) return;
    const panel = String(config.panel || 'http://127.0.0.1:4000').replace(/\/$/, '');
    const url = panel + '/?embed=1&action=' + encodeURIComponent(item.id);
    view = 'action';
    sheet().innerHTML = '<div class="top">' + tabs() + '<b></b><button data-go="-1" title="Previous action">◀</button><button data-go="1" title="Next action">▶</button>' +
      '<a target="_blank" rel="noopener" title="Open in the panel">panel ↗</a><button data-close title="Close">✕</button></div>' +
      '<iframe title="Action dossier"></iframe>';
    shown.querySelector('b').textContent = (index + 1) + '/' + recorded.length + ' · ' + item.label;
    shown.querySelector('a').href = panel + '/?action=' + encodeURIComponent(item.id);
    shown.querySelector('iframe').src = url;
    shown.querySelector('[data-close]').addEventListener('click', () => { shown.remove(); shown = null; });
    for (const button of shown.querySelectorAll('[data-go]')) {
      button.addEventListener('click', () => showAction(Math.max(0, Math.min(recorded.length - 1, index + Number(button.dataset.go)))));
    }
    wireTabs();
    panelMissing(panel);
  }
  // Mounted after the page has loaded, so it never takes part in hydration.
  function whenLoaded() {
    const mount = () => setTimeout(mountBar, 300);
    if (document.readyState === 'complete') mount();
    else addEventListener.call(window, 'load', mount, { once: true });
  }

  continued();
  whenLoaded();
  window.__codetac = { recorded, config };
})();
