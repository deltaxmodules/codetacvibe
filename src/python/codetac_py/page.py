"""Browser side, served by the observed app's own Python server, as src/page.mjs
does for Node: HTML pages get a <script src="/__codetac/bar.js">, and the
/__codetac/ routes are answered here without ever reaching the app. It works
at the protocol level (WSGI and ASGI), for any framework on top of them.

- the action of a request: the x-codetac-action header set by the page script
  on fetch and XHR, or the short cookie it sets before a full navigation;
- /__codetac/bar.js serves the same bar.js as the Node side (CODETAC_BAR_JS),
  /__codetac/events records the page's actions (`browser-action`), and
  /__codetac/review gives the panel's count of changes not opened (phase 11);
- the script tag goes into complete HTML documents: known length (or a body
  given whole), not compressed, not a file, 1 MB at most. The length is
  adjusted, and validators (ETag, Last-Modified) are dropped only when the
  body changes. Streams (no length), files and compressed bodies pass
  untouched. Error pages (500) get the bar too.

Keep it importable on old Pythons (3.8+): the minimal mode has the bar too.
"""
import json
import math
import os
import re

PREFIX = '/__codetac/'
ACTION_HEADER = 'x-codetac-action'
INTERNAL_HEADER = 'x-codetac-internal'
_ACTION_ID = re.compile(r'^[A-Za-z0-9_-]{6,40}$')
_ACTION_NUMBER = re.compile(r'^\d{1,5}$')
_ACTION_COOKIE = re.compile(r'(?:^|;\s*)codetac_action=([A-Za-z0-9_-]{6,40})(?:;|$)')
MAX_EVENT_BYTES = 64 * 1024
MAX_PAGE_BYTES = 1024 * 1024
TAG = b'<script src="/__codetac/bar.js" data-codetac=""></script>'
_HEAD = re.compile(br'<head(?:\s[^>]*)?>', re.IGNORECASE)
_BODY = re.compile(br'<body[\s>]', re.IGNORECASE)
_LEADING = br'(?:\s|<!--.*?-->)*'
_OPENING_HTML = re.compile(_LEADING + br'(?:<!doctype html[^>]*>' + _LEADING + br')?<html(?:\s[^>]*)?>', re.IGNORECASE | re.DOTALL)
_OPENING_DOCTYPE = re.compile(_LEADING + br'<!doctype html[^>]*>', re.IGNORECASE | re.DOTALL)
_HTML = re.compile(r'text/html', re.IGNORECASE)
DROPPED = ('content-length', 'etag', 'last-modified')
BAR_JS = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'browser', 'bar.js'))
# The bar's sentences (src/structure/text/en.json, section bar), as src/page.mjs gives them.
TEXT_JSON = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'structure', 'text', 'en.json'))


def enabled():
    return os.environ.get('CODETAC_PAGE') != '0'


def panel_url():
    """src/page.mjs panelUrl."""
    return os.environ.get('CODETAC_PANEL_URL') or 'http://127.0.0.1:%s' % (os.environ.get('CODETAC_PANEL_PORT') or 4000)


_script = None


def bar_text():
    try:
        with open(TEXT_JSON, encoding='utf-8') as file:
            return json.load(file).get('bar', {})
    except (OSError, ValueError):
        return {}


def bar_script():
    global _script
    if _script is None:
        config = {'panel': panel_url(), 'run': os.environ.get('CODETAC_RUN', ''), 'text': bar_text()}
        with open(os.environ.get('CODETAC_BAR_JS') or BAR_JS, 'rb') as file:
            source = file.read()
        _script = ('window.__CODETAC_CONFIG__=%s;\n' % json.dumps(config, separators=(',', ':'))).encode('utf-8') + source
    return _script


def action_of(header, fetch_mode, cookie):
    """src/page.mjs actionOf: {'action', 'actionRequest'} or None."""
    if isinstance(header, str):
        parts = header.split('.')
        if _ACTION_ID.match(parts[0]):
            number = parts[1] if len(parts) > 1 else ''
            return {'action': parts[0], 'actionRequest': int(number) if _ACTION_NUMBER.match(number) else None}
    if fetch_mode == 'navigate':
        match = _ACTION_COOKIE.search(cookie or '')
        if match:
            return {'action': match.group(1), 'actionRequest': None}
    return None


def wants_page(method, destination, accept):
    """src/page.mjs wantsPage: top-level HTML documents."""
    if method != 'GET':
        return False
    if destination:
        return destination == 'document'
    return bool(_HTML.search(accept or ''))


def insert_tag(body, final):
    """src/page.mjs tagPosition: after <head ...>; in a whole document without a head,
    before <body>, or else after <html ...> or <!doctype html> (werkzeug's error pages have
    neither head nor body). None while more of the body is needed; the body unchanged when
    there is nowhere to put it (fragments)."""
    head = _HEAD.search(body)
    if head:
        at = head.end()
    elif not final:
        return None
    else:
        match = _BODY.search(body)
        opening = match is None and (_OPENING_HTML.match(body) or _OPENING_DOCTYPE.match(body))
        if match:
            at = match.start()
        elif opening:
            at = opening.end()
        else:
            return body
    return body[:at] + TAG + body[at:]


def injectable(status, headers):
    """Whether the response is an HTML document the tag can go into: `headers` as
    (lower-case name, value) pairs. Returns the declared length (or -1), or None."""
    if not 200 <= status < 600 or status in (204, 206, 304):
        return None
    kind = length = None
    for name, value in headers:
        if name == 'content-type':
            kind = value
        elif name in ('content-encoding', 'content-range') and value.strip().lower() not in ('', 'identity'):
            return None
        elif name == 'content-length':
            try:
                length = int(value.strip())
            except ValueError:
                return None
    if not kind or not _HTML.search(kind):
        return None
    if length is None:
        return -1
    return length if length <= MAX_PAGE_BYTES else None


def adjusted(headers, length):
    """Headers (name, value), as given, for a body that changed to `length` bytes."""
    result = [(name, value) for name, value in headers if name.lower() not in DROPPED]
    result.append(('Content-Length', str(length)))
    return result


# Browser actions -----------------------------------------------------------------

def _text(value, maximum=120):
    if not isinstance(value, str):
        return None
    return ' '.join(value.split())[:maximum]


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if math.isfinite(value) else None


def _frames(items):
    if not isinstance(items, list):
        return None
    result = []
    for frame in items[:16]:
        frame = frame if isinstance(frame, dict) else {}
        item = {'fn': _text(frame.get('fn'), 80), 'url': _text(frame.get('url'), 500), 'line': _number(frame.get('line')),
                'column': _number(frame.get('column')), 'file': _text(frame.get('file'), 500)}
        if item['url'] or item['file']:
            result.append(item)
    return result


def _names(items):
    if not isinstance(items, list):
        return None
    result = []
    for item in items[:40]:
        item = item if isinstance(item, dict) else {}
        entry = {'name': _text(item.get('name'), 80), 'count': _number(item.get('count')), 'frames': _frames(item.get('frames'))}
        if entry['name']:
            result.append(entry)
    return result


def _path_of(raw):
    if not isinstance(raw, str):
        return {}
    from .servers import split_target
    try:
        path, keys = split_target(raw)
    except Exception:
        return {'path': '[invalid]', 'queryKeys': []}
    return {'path': path, 'queryKeys': keys}


def _clean(value):
    """Drops the fields that are None, as JSON.stringify drops undefined."""
    if isinstance(value, dict):
        return {key: _clean(item) for key, item in value.items() if item is not None}
    if isinstance(value, list):
        return [_clean(item) for item in value]
    return value


def browser_action(event):
    """src/page.mjs recordBrowserAction: only known fields; URLs lose their query values.
    The writer redacts the event before it is written."""
    if not isinstance(event, dict) or not _ACTION_ID.match(str(event.get('actionId'))):
        return None
    trigger = event.get('trigger') if isinstance(event.get('trigger'), dict) else None
    shaped = None
    if trigger:
        element = trigger.get('element') if isinstance(trigger.get('element'), dict) else {}
        component = trigger.get('component') if isinstance(trigger.get('component'), dict) else None
        handler = trigger.get('handler') if isinstance(trigger.get('handler'), dict) else None
        owners = None
        if component and isinstance(component.get('owners'), list):
            owners = [{'name': _text(owner.get('name'), 80), 'frames': _frames(owner.get('frames'))}
                      for owner in component['owners'][:6] if isinstance(owner, dict)]
            owners = [owner for owner in owners if owner['name']]
        shaped = {
            'event': _text(trigger.get('event'), 20),
            'element': {'tag': _text(element.get('tag'), 20), 'type': _text(element.get('type'), 20), 'role': _text(element.get('role'), 30),
                        'text': _text(element.get('text'), 80), 'label': _text(element.get('label'), 80), 'name': _text(element.get('name'), 60),
                        'id': _text(element.get('id'), 60), 'href': _path_of(element['href']).get('path') if element.get('href') else None},
            'component': {'name': _text(component.get('name'), 80), 'owners': owners, 'frames': _frames(component.get('frames'))} if component else None,
            'handler': {'name': _text(handler.get('name'), 80), 'prop': _text(handler.get('prop'), 30),
                        'source': _text(handler.get('source'), 20)} if handler else None,
        }
    requests = []
    for item in event.get('requests')[:200] if isinstance(event.get('requests'), list) else []:
        item = item if isinstance(item, dict) else {}
        same = bool(item.get('sameOrigin'))
        entry = {'n': _number(item.get('n')), 'kind': _text(item.get('kind'), 20), 'method': _text(item.get('method'), 10)}
        entry.update(_path_of(item.get('url')))
        entry.update({'sameOrigin': same, 'host': None if same else _text(item.get('host'), 200),
                      'startMs': _number(item.get('startMs')), 'durationMs': _number(item.get('durationMs')), 'status': _number(item.get('status')),
                      'error': True if item.get('error') else None, 'frames': _frames(item.get('frames'))})
        requests.append(entry)
    screen = event.get('screen') if isinstance(event.get('screen'), dict) else None
    navigations = None
    if isinstance(event.get('navigations'), list):
        navigations = []
        for item in event['navigations'][:20]:
            item = item if isinstance(item, dict) else {}
            entry = {'kind': _text(item.get('kind'), 20)}
            entry.update(_path_of(item.get('to')))
            entry['atMs'] = _number(item.get('atMs'))
            navigations.append(entry)
    segment = _number(event.get('segment'))
    return _clean({
        'type': 'browser-action', 'actionId': event['actionId'], 'segment': 1 if segment is None else segment,
        'origin': _text(event.get('origin'), 200), 'page': _path_of(event.get('page')),
        'startedAt': _number(event.get('startedAt')), 'durationMs': _number(event.get('durationMs')), 'closedBy': _text(event.get('closedBy'), 40),
        'trigger': shaped, 'requests': requests,
        'screen': {'added': _number(screen.get('added')), 'removed': _number(screen.get('removed')), 'text': _number(screen.get('text')),
                   'attributes': _number(screen.get('attributes')), 'title': True if screen.get('title') else None,
                   'stateChanged': _names(screen.get('stateChanged')), 'mounted': _names(screen.get('mounted')),
                   'unmounted': _names(screen.get('unmounted'))} if screen else None,
        'scripts': [url for url in (_text(url, 500) for url in event['scripts'][:80]) if url] if isinstance(event.get('scripts'), list) else None,
        'navigations': navigations,
    })


def _same_origin(origin, host):
    if not origin:
        return True
    from urllib.parse import urlsplit
    try:
        return urlsplit(origin).netloc == host
    except ValueError:
        return False


_LOOPBACK = ('127.0.0.1', 'localhost', '::1')


def review_total(timeout=3):
    """src/page.mjs reviewTotal: the panel's count of changes not opened, or None. Only
    a panel on this computer is asked (the number never leaves it), with a short wait,
    and the request is not recorded as a call of the app."""
    run = os.environ.get('CODETAC_RUN', '')
    from urllib.parse import quote, urlsplit
    try:
        parts = urlsplit(panel_url())
        port = parts.port or 80
    except ValueError:
        return None
    if parts.scheme != 'http' or parts.hostname not in _LOOPBACK or not run:
        return None
    import http.client
    try:
        from .boundaries import _inside
        token = _inside.set(True)
    except Exception:
        _inside = token = None
    connection = None
    try:
        connection = http.client.HTTPConnection(parts.hostname, port, timeout=timeout)
        connection.request('GET', '/api/structure/review?run=' + quote(run, safe=''), headers={INTERNAL_HEADER: '1'})
        answer = connection.getresponse()
        body = answer.read()
        if answer.status != 200:
            return None
        review = json.loads(body.decode('utf-8')).get('review') or {}
        return int(review.get('total') or 0)
    except Exception:
        return None
    finally:
        if connection is not None:
            connection.close()
        if token is not None:
            _inside.reset(token)


def own_route(method, path, origin, host, read_body, fetch_site=None):
    """Answers a /__codetac/ request: (status, headers, body). `read_body(limit)` returns
    the request body, or None when it is longer than the limit."""
    if path == PREFIX + 'bar.js' and method == 'GET':
        return 200, [('Content-Type', 'text/javascript; charset=utf-8'), ('Cache-Control', 'no-store')], bar_script()
    # Comprehension debt (phase 10, step 4; Python side in phase 11): the number on the
    # bar's Structure pill, asked of the panel on this computer. Only the page itself may ask.
    if path == PREFIX + 'review' and method == 'GET':
        if not _same_origin(origin, host) or fetch_site == 'cross-site':
            return 403, [('Content-Type', 'text/plain; charset=utf-8')], 'CodeTAC: origin refused.'.encode('utf-8')
        body = json.dumps({'total': review_total()}, separators=(',', ':')).encode('utf-8')
        return 200, [('Content-Type', 'application/json; charset=utf-8'), ('Cache-Control', 'no-store')], body
    if path == PREFIX + 'events' and method == 'POST':
        # Only the page itself may report actions: another site open in the
        # browser cannot write into the recording (browsers send Origin here).
        if not _same_origin(origin, host):
            return 403, [('Content-Type', 'text/plain; charset=utf-8')], 'CodeTAC: origin refused.'.encode('utf-8')
        body = read_body(MAX_EVENT_BYTES)
        if body is None:
            return 413, [('Cache-Control', 'no-store')], b''
        try:
            event = browser_action(json.loads(body.decode('utf-8')))
            if event is not None:
                import codetac_py
                codetac_py.writer.emit(event)
        except Exception:
            pass
        return 204, [('Cache-Control', 'no-store')], b''
    return 404, [('Content-Type', 'text/plain; charset=utf-8')], 'CodeTAC: rota desconhecida.'.encode('utf-8')


def emit_page(path):
    import codetac_py
    codetac_py.writer.emit({'type': 'page', 'path': path})


# WSGI ------------------------------------------------------------------------------

def wsgi_own_route(environ, start_response):
    def read_body(limit):
        try:
            length = int(environ.get('CONTENT_LENGTH') or 0)
        except ValueError:
            length = 0
        if length > limit:
            return None
        stream = environ.get('wsgi.input')
        return stream.read(length) if stream is not None and length > 0 else b''

    status, headers, body = own_route(environ.get('REQUEST_METHOD', 'GET'), environ.get('PATH_INFO', ''),
                                      environ.get('HTTP_ORIGIN'), environ.get('HTTP_HOST'), read_body, environ.get('HTTP_SEC_FETCH_SITE'))
    reasons = {200: 'OK', 204: 'No Content', 403: 'Forbidden', 404: 'Not Found', 413: 'Payload Too Large'}
    start_response('%d %s' % (status, reasons[status]), headers + [('Content-Length', str(len(body)))])
    return [body]


class WsgiPage(object):
    """The response of a page request: start_response is held until the body shows whether
    the tag goes in. The server sends nothing before the first chunk anyway (PEP 3333)."""

    def __init__(self, start_response):
        self.start_response = start_response
        self.held = None      # (status, headers, exc_info) while undecided
        self.mode = None      # None: undecided; 'pass'; 'buffer'
        self.length = -1

    def start(self, status, headers, exc_info=None):
        if self.mode == 'pass':
            return self.start_response(status, headers, exc_info) if exc_info else self.start_response(status, headers)
        try:
            code = int(str(status).split(' ', 1)[0])
            length = injectable(code, [(name.lower(), value) for name, value in headers])
        except Exception:
            length = None
        if length is None:
            self.mode = 'pass'
            return self.start_response(status, headers, exc_info) if exc_info else self.start_response(status, headers)
        self.mode = 'buffer'
        self.length = length
        self.held = (status, headers, exc_info)
        return self._write

    def _write(self, data):
        # The legacy write() callable: the headers must go now, unchanged.
        self._release(None)
        return self.write(data)

    def _release(self, body):
        """Sends the held headers, for `body` (None: the original response goes on unchanged)."""
        status, headers, exc_info = self.held
        self.held = None
        self.mode = 'pass'
        if body is not None:
            headers = adjusted(headers, len(body))
        self.write = self.start_response(status, headers, exc_info) if exc_info else self.start_response(status, headers)

    def body(self, result):
        """The iterable to return to the server."""
        if self.mode == 'pass':
            return result
        # Files (werkzeug's and wsgiref's FileWrapper, the server's file_wrapper): untouched.
        if type(result).__name__ == 'FileWrapper' or hasattr(result, 'filelike'):
            if self.mode == 'buffer':
                self._release(None)
            return result
        return _Iterated(self, result)


class _Iterated(object):
    """The body of a page request; close() is the original body's."""

    def __init__(self, page, result):
        self.page = page
        self.result = result
        self.iterator = None

    def __iter__(self):
        if self.iterator is None:
            self.iterator = self._iterate()
        return self.iterator

    def close(self):
        close = getattr(self.result, 'close', None)
        if close is not None:
            close()

    def _iterate(self):
        # start_response may be called while the body is being iterated
        # (generators, the werkzeug debugger).
        page, result = self.page, self.result
        piecewise = not isinstance(result, (list, tuple))
        chunks = []
        size = 0
        for chunk in result:
            if page.mode != 'buffer':
                if chunks:
                    yield b''.join(chunks)
                    chunks = []
                yield chunk
                continue
            if page.length < 0 and piecewise:
                # A stream (no length, given piece by piece): untouched.
                page._release(None)
                yield chunk
                continue
            chunks.append(chunk)
            size += len(chunk)
            if size > MAX_PAGE_BYTES:
                page._release(None)
                yield b''.join(chunks)
                chunks = []
        if page.mode == 'buffer':
            body = b''.join(chunks)
            changed = insert_tag(body, True)
            if page.length >= 0 and len(body) != page.length or changed == body:
                page._release(None)
            else:
                page._release(changed)
                body = changed
            yield body
        elif chunks:
            yield b''.join(chunks)


# ASGI ------------------------------------------------------------------------------

async def asgi_own_route(scope, receive, send):
    headers = dict((key.decode('latin-1').lower(), value.decode('latin-1')) for key, value in scope.get('headers') or [])
    received = []

    async def read_all():
        size = 0
        while True:
            message = await receive()
            if message.get('type') != 'http.request':
                return None
            chunk = message.get('body') or b''
            size += len(chunk)
            if size <= MAX_EVENT_BYTES:
                received.append(chunk)
            if not message.get('more_body'):
                return size

    size = await read_all() if scope.get('method') == 'POST' else 0
    arguments = (scope.get('method', 'GET'), scope.get('path', ''), headers.get('origin'), headers.get('host'),
                 lambda limit: None if size is None or size > limit else b''.join(received), headers.get('sec-fetch-site'))
    if scope.get('path') == PREFIX + 'review':
        # Asking the panel waits on the network: not on the event loop.
        import asyncio
        status, answer, body = await asyncio.get_running_loop().run_in_executor(None, lambda: own_route(*arguments))
    else:
        status, answer, body = own_route(*arguments)
    await send({'type': 'http.response.start', 'status': status,
                'headers': [(name.lower().encode('latin-1'), value.encode('latin-1')) for name, value in answer]
                + [(b'content-length', str(len(body)).encode())]})
    await send({'type': 'http.response.body', 'body': body})


class AsgiPage(object):
    """The response of a page request, for ASGI: http.response.start is held until the
    body shows whether the tag goes in."""

    def __init__(self, send):
        self.send = send
        self.mode = None
        self.start = None
        self.length = -1
        self.chunks = []
        self.size = 0

    async def __call__(self, message):
        kind = message.get('type')
        if self.mode == 'pass' or kind not in ('http.response.start', 'http.response.body'):
            if self.mode == 'buffer':
                # Files (http.response.pathsend, zerocopy) or anything else: untouched.
                await self._release(None)
            return await self.send(message)
        if kind == 'http.response.start':
            try:
                self.length = injectable(int(message.get('status')), [(key.decode('latin-1').lower(), value.decode('latin-1'))
                                                                      for key, value in message.get('headers') or []])
            except Exception:
                self.length = None
            if self.length is None or self.length < 0:
                # Without a length it is a stream (StreamingResponse): untouched.
                self.mode = 'pass'
                return await self.send(message)
            self.mode = 'buffer'
            self.start = message
            return None
        body = message.get('body') or b''
        self.chunks.append(body)
        self.size += len(body)
        if message.get('more_body', False):
            if self.size > MAX_PAGE_BYTES:
                await self._release(None)
            return None
        whole = b''.join(self.chunks)
        self.chunks = []
        changed = insert_tag(whole, True)
        if len(whole) != self.length or changed == whole:
            await self._release(None, whole)
        else:
            await self._release(changed)

    async def _release(self, changed, whole=None):
        start, self.start = self.start, None
        self.mode = 'pass'
        if changed is not None:
            headers = [(key, value) for key, value in start.get('headers') or [] if key.decode('latin-1').lower() not in DROPPED]
            headers.append((b'content-length', str(len(changed)).encode()))
            start = dict(start, headers=headers)
            await self.send(start)
            await self.send({'type': 'http.response.body', 'body': changed})
            return
        await self.send(start)
        if whole is not None:
            await self.send({'type': 'http.response.body', 'body': whole})
            return
        chunks, self.chunks = self.chunks, []
        for chunk in chunks:
            await self.send({'type': 'http.response.body', 'body': chunk, 'more_body': True})
