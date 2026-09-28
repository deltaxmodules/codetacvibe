"""Requests as the unit, at the server (protocol level, never the framework).

A meta path finder patches a server module right after it is imported,
before the code that imported it can bind its names:

- the WSGI or ASGI callable the server runs is wrapped: each HTTP request
  becomes a `request` / `request-end` pair, and everything it causes carries
  its id (see context.py). Lifespan and websocket pass untouched;
- the processes that only supervise the one that serves are recognised: the
  reloader of werkzeug (run_simple with the reloader, outside the child with
  WERKZEUG_RUN_MAIN=true), the supervisor of uvicorn --reload/--workers and
  fastapi dev (Config.bind_socket), and the gunicorn arbiter;
- the real port (`listening`): socket.listen, and the sockets uvicorn
  reports after starting (uvloop opens them in C).

The events are those of the Node runtime (src/boundaries.mjs, runtime.mjs).
Keep it importable on old Pythons (3.8+): the minimal mode records requests.
"""
import functools
import itertools
import json
import os
import socket
import sys
import time
from email.utils import parsedate_to_datetime
from urllib.parse import parse_qsl, quote, unquote, urlsplit

from . import page
from .context import after_response, current, scope
from .hooks import register

INTERNAL_HEADER = page.INTERNAL_HEADER  # CodeTAC's own requests (src/page.mjs)
_requests = itertools.count(1)


def _codetac():
    import codetac_py
    return codetac_py


# Requests --------------------------------------------------------------------------

def safe_path(path):
    """src/boundaries.mjs safePath: long opaque segments (tokens in paths) are hidden."""
    segments = []
    for segment in path.split('/'):
        plain = unquote(segment)
        opaque = (len(plain) >= 20 and all(c.isascii() and (c.isalnum() or c in '_.~-') for c in plain)
                  and any(c.isdigit() for c in plain) and any(c.isascii() and c.isalpha() for c in plain))
        segments.append('[REDACTED]' if opaque else segment)
    return '/'.join(segments)


def split_target(target):
    """Path without query values, and the query's keys (src/boundaries.mjs splitUrl)."""
    try:
        parts = urlsplit(target)
    except ValueError:
        return '[invalid]', []
    keys = []
    for key, _ in parse_qsl(parts.query, keep_blank_values=True):
        if key not in keys:
            keys.append(key)
    return safe_path(parts.path or '/'), keys


def cookie_names(values):
    """Set-Cookie headers -> [{name, cleared}], names only (src/runtime.mjs cookieNames)."""
    found = {}
    for value in values:
        pair, _, rest = value.partition(';')
        name = pair.split('=', 1)[0].strip()
        if not name:
            continue
        max_age = expires = None
        for attribute in rest.split(';'):
            key, _, text = attribute.strip().partition('=')
            if key.lower() == 'max-age' and max_age is None:
                try:
                    max_age = int(text.strip())
                except ValueError:
                    pass
            elif key.lower() == 'expires' and expires is None and text.strip():
                expires = text.strip()
        cleared = False
        if max_age is not None:
            cleared = max_age <= 0
        elif expires:
            try:
                cleared = parsedate_to_datetime(expires).timestamp() < time.time()
            except (TypeError, ValueError, IndexError):
                cleared = False
        found[name] = {'name': name, 'cleared': cleared}
    return list(found.values()) or None


def cross_origin(origin, host):
    """(origin, host) when the Origin header names another origin than the Host, else None."""
    if not origin or not host or origin == 'null':
        return None
    try:
        parts = urlsplit(origin)
    except ValueError:
        return None
    if parts.scheme not in ('http', 'https') or not parts.netloc or parts.netloc == host:
        return None
    return '%s://%s' % (parts.scheme, parts.netloc), host


class Unit(object):
    """One incoming HTTP request."""

    def __init__(self, method, target, action=None, origin=None, host=None):
        writer = _codetac().writer
        self.writer = writer
        self.id = '%s:r%d' % (writer.process, next(_requests))
        self.json = json.dumps(self.id)
        path, keys = split_target(target)
        node = current.get()[0]
        event = {'type': 'request', 'requestId': self.id, 'parentId': None if node is None else '%s:%d' % (writer.process, node),
                 'method': method, 'path': path, 'queryKeys': keys, 'at': int(time.time() * 1000)}
        # A page of another origin calling this server (a frontend on another
        # port without a proxy): the origin and the host (scheme, name and port
        # only) let the store make a probable link to the browser's request.
        cross = cross_origin(origin, host)
        if cross:
            event['origin'], event['host'] = cross
        # The browser action that caused it, when the page script marked it.
        if action:
            event['action'] = action['action']
            if action['actionRequest'] is not None:
                event['actionRequest'] = action['actionRequest']
        writer.emit(event)
        self.start = time.perf_counter_ns()
        self.status = None
        self.cookies = None
        self.done = False

    def enter(self):
        return current.set(scope(current.get()[0], self.json))

    def enter_after(self):
        """What runs from now on happens after the response (afterResponse: true)."""
        return current.set(scope(current.get()[0], after_response(self.json)))

    def end(self, aborted):
        if self.done:
            return
        self.done = True
        event = {'type': 'request-end', 'requestId': self.id, 'status': self.status, 'aborted': bool(aborted),
                 'durationNs': time.perf_counter_ns() - self.start}
        if self.cookies:
            event['cookies'] = self.cookies
        self.writer.emit(event)


# WSGI ------------------------------------------------------------------------------

def _wsgi_target(environ):
    target = environ.get('REQUEST_URI') or environ.get('RAW_URI')
    if not target:
        path = (environ.get('SCRIPT_NAME', '') + environ.get('PATH_INFO', '')).encode('latin-1', 'replace')
        target = quote(path) + ('?' + environ['QUERY_STRING'] if environ.get('QUERY_STRING') else '')
    return target


class _Body(object):
    """The response body, iterated inside the request. The request ends when the body has
    been given whole, like 'finish' in Node: servers may call close() much later (werkzeug
    first drains the socket, which a browser keeps open after a POST). What close() runs
    (Flask's teardown) still belongs to the request, after its end; a body not given
    whole ends, aborted, on close()."""

    def __init__(self, result, unit):
        self.result = result
        self.unit = unit
        self.iterator = None
        self.finished = False

    def __iter__(self):
        return self

    def __next__(self):
        token = self.unit.enter()
        try:
            if self.iterator is None:
                self.iterator = iter(self.result)
            return next(self.iterator)
        except StopIteration:
            self.finished = True
            self.unit.end(False)
            raise
        finally:
            current.reset(token)

    def close(self):
        try:
            close = getattr(self.result, 'close', None)
            if close is not None:
                token = self.unit.enter_after() if self.unit.done else self.unit.enter()
                try:
                    close()
                finally:
                    current.reset(token)
        finally:
            self.unit.end(not self.finished)


def wrap_wsgi(app):
    if app is None or getattr(app, '__codetac_wrapped__', False):
        return app

    def codetac_wsgi(environ, start_response):
        # CodeTAC's own routes never reach the app.
        if environ.get('PATH_INFO', '').startswith(page.PREFIX):
            return page.wsgi_own_route(environ, start_response)
        if environ.get('HTTP_' + INTERNAL_HEADER.upper().replace('-', '_')):
            return app(environ, start_response)
        document = None
        try:
            method = environ.get('REQUEST_METHOD', 'GET')
            target = _wsgi_target(environ)
            if page.enabled() and page.wants_page(method, environ.get('HTTP_SEC_FETCH_DEST'), environ.get('HTTP_ACCEPT')):
                # Pages are asked for uncompressed, so the tag can go in.
                environ.pop('HTTP_ACCEPT_ENCODING', None)
                document = page.WsgiPage(start_response)
                start_response = document.start
                page.emit_page(split_target(target)[0])
            unit = Unit(method, target, page.action_of(environ.get('HTTP_' + page.ACTION_HEADER.upper().replace('-', '_')),
                                                       environ.get('HTTP_SEC_FETCH_MODE'), environ.get('HTTP_COOKIE')),
                        environ.get('HTTP_ORIGIN'), environ.get('HTTP_HOST'))
        except Exception:
            return app(environ, start_response)

        def start(status, headers, exc_info=None):
            try:
                unit.status = int(str(status).split(' ', 1)[0])
                unit.cookies = cookie_names([value for key, value in headers if key.lower() == 'set-cookie'])
            except Exception:
                pass
            if exc_info is None:
                return start_response(status, headers)
            return start_response(status, headers, exc_info)

        token = unit.enter()
        try:
            result = app(environ, start)
        except BaseException:
            # The server answers 500 on its own.
            unit.status = unit.status or 500
            unit.end(False)
            raise
        finally:
            current.reset(token)
        return _Body(result if document is None else document.body(result), unit)

    codetac_wsgi.__codetac_wrapped__ = True
    _copy_names(app, codetac_wsgi)
    return codetac_wsgi


def _copy_names(app, wrapper):
    # Not functools.wraps: the app is often an object (Flask, FastAPI) whose
    # whole __dict__ it would copy.
    for name in ('__name__', '__qualname__', '__doc__'):
        try:
            setattr(wrapper, name, getattr(app, name))
        except (AttributeError, TypeError):
            pass


# ASGI ------------------------------------------------------------------------------

def _asgi_target(scope):
    path = scope.get('raw_path') or quote(scope.get('root_path', '') + scope.get('path', '/')).encode()
    if isinstance(path, bytes):
        path = path.decode('latin-1')
    query = scope.get('query_string') or b''
    return path + ('?' + query.decode('latin-1') if query else '')


def wrap_asgi(app):
    if app is None or getattr(app, '__codetac_wrapped__', False):
        return app

    async def codetac_asgi(scope, receive, send):
        # Lifespan and websocket pass untouched.
        if scope.get('type') != 'http':
            return await app(scope, receive, send)
        # CodeTAC's own routes never reach the app.
        if scope.get('path', '').startswith(page.PREFIX):
            return await page.asgi_own_route(scope, receive, send)
        headers = {}
        for key, value in scope.get('headers') or []:
            headers.setdefault(key.decode('latin-1').lower(), value.decode('latin-1'))
        if INTERNAL_HEADER in headers:
            return await app(scope, receive, send)
        try:
            method = scope.get('method', 'GET')
            target = _asgi_target(scope)
            if page.enabled() and page.wants_page(method, headers.get('sec-fetch-dest'), headers.get('accept')):
                # Pages are asked for uncompressed, so the tag can go in.
                scope = dict(scope, headers=[(key, value) for key, value in scope.get('headers') or []
                                             if key.lower() != b'accept-encoding'])
                send = page.AsgiPage(send)
                page.emit_page(split_target(target)[0])
            unit = Unit(method, target, page.action_of(headers.get(page.ACTION_HEADER), headers.get('sec-fetch-mode'), headers.get('cookie')),
                        headers.get('origin'), headers.get('host'))
        except Exception:
            return await app(scope, receive, send)

        async def codetac_send(message):
            kind = message.get('type')
            if kind == 'http.response.start':
                try:
                    unit.status = message.get('status')
                    unit.cookies = cookie_names([value.decode('latin-1') for key, value in message.get('headers') or []
                                                 if key.lower() == b'set-cookie'])
                except Exception:
                    pass
            await send(message)
            if kind == 'http.response.body' and not message.get('more_body', False) and not unit.done:
                unit.end(False)
                # Work after the response (BackgroundTasks) runs on in this task.
                unit.enter_after()

        token = unit.enter()
        try:
            # Work after the response (BackgroundTasks) still belongs to the request.
            await app(scope, receive, codetac_send)
        finally:
            current.reset(token)
            unit.end(True)

    codetac_asgi.__codetac_wrapped__ = True
    _copy_names(app, codetac_asgi)
    return codetac_asgi


# listening -------------------------------------------------------------------------

_announced = set()
# The server that runs the app, for `codetac diagnostico`: the first one loaded,
# in this order (gunicorn with the uvicorn worker loads both).
_SERVERS = ('gunicorn', 'uvicorn', 'hypercorn', 'granian', 'waitress', 'werkzeug', 'wsgiref.simple_server')


def server_name():
    for name in _SERVERS:
        if name in sys.modules:
            return name.split('.')[0]
    return None


def announce(sock):
    """One `listening` per port and address of this process."""
    try:
        if sock.family in (socket.AF_INET, socket.AF_INET6) and sock.type == socket.SOCK_STREAM:
            address = sock.getsockname()
            key = (os.getpid(), address[0], address[1])
            if key not in _announced:
                _announced.add(key)
                event = {'type': 'listening', 'port': address[1], 'address': address[0]}
                server = server_name()
                if server:
                    event['server'] = server
                _codetac().writer.emit(event)
    except Exception:
        pass


def _install_listening():
    original = socket.socket.listen
    if getattr(original, '__codetac_wrapped__', False):
        return

    @functools.wraps(original)
    def listen(self, *args):
        result = original(self, *args)
        announce(self)
        return result

    listen.__codetac_wrapped__ = True
    socket.socket.listen = listen


# Servers ---------------------------------------------------------------------------

def _mark(server):
    _codetac().mark_supervisor(server)


def _patch_werkzeug_serving(module):
    run_simple = module.run_simple

    @functools.wraps(run_simple)
    def codetac_run_simple(*args, **kwargs):
        use_reloader = kwargs.get('use_reloader', args[3] if len(args) > 3 else False)
        if use_reloader and os.environ.get('WERKZEUG_RUN_MAIN') != 'true':
            _mark('werkzeug')
        return run_simple(*args, **kwargs)

    module.run_simple = codetac_run_simple
    # run_simple and make_server both build a BaseWSGIServer.
    init = module.BaseWSGIServer.__init__

    @functools.wraps(init)
    def codetac_init(self, *args, **kwargs):
        init(self, *args, **kwargs)
        self.app = wrap_wsgi(self.app)

    module.BaseWSGIServer.__init__ = codetac_init


def _patch_uvicorn_config(module):
    bind_socket = module.Config.bind_socket

    @functools.wraps(bind_socket)
    def codetac_bind_socket(self, *args, **kwargs):
        _mark('uvicorn')
        return bind_socket(self, *args, **kwargs)

    module.Config.bind_socket = codetac_bind_socket
    # The app uvicorn serves, whatever the worker: after load(), loaded_app is
    # the app with uvicorn's own middlewares (WSGI apps are already adapted).
    load = module.Config.load

    @functools.wraps(load)
    def codetac_load(self, *args, **kwargs):
        load(self, *args, **kwargs)
        self.loaded_app = wrap_asgi(self.loaded_app)

    module.Config.load = codetac_load


def _patch_uvicorn_server(module):
    # With uvloop the port is opened in C, without socket.listen: the server
    # says which sockets it listens on once it has started.
    startup = module.Server.startup

    @functools.wraps(startup)
    async def codetac_startup(self, *args, **kwargs):
        result = await startup(self, *args, **kwargs)
        for server in getattr(self, 'servers', None) or []:
            for sock in getattr(server, 'sockets', None) or []:
                announce(sock)
        return result

    module.Server.startup = codetac_startup


def _patch_gunicorn_arbiter(module):
    run = module.Arbiter.run

    @functools.wraps(run)
    def codetac_run(self, *args, **kwargs):
        _mark('gunicorn')
        return run(self, *args, **kwargs)

    module.Arbiter.run = codetac_run


def _patch_gunicorn_worker(module):
    load_wsgi = module.Worker.load_wsgi

    @functools.wraps(load_wsgi)
    def codetac_load_wsgi(self, *args, **kwargs):
        load_wsgi(self, *args, **kwargs)
        # gunicorn's own workers run WSGI; the ASGI ones (uvicorn-worker) go
        # through uvicorn's Config.load.
        if type(self).__module__.startswith('gunicorn.workers.'):
            self.wsgi = wrap_wsgi(self.wsgi)

    module.Worker.load_wsgi = codetac_load_wsgi


def _patch_waitress_server(module):
    create_server = module.create_server

    @functools.wraps(create_server)
    def codetac_create_server(application, *args, **kwargs):
        return create_server(wrap_wsgi(application), *args, **kwargs)

    module.create_server = codetac_create_server


def _patch_wsgiref(module):
    set_app = module.WSGIServer.set_app

    @functools.wraps(set_app)
    def codetac_set_app(self, application):
        return set_app(self, wrap_wsgi(application))

    module.WSGIServer.set_app = codetac_set_app


SERVER_HOOKS = {
    'werkzeug.serving': _patch_werkzeug_serving,
    'uvicorn.config': _patch_uvicorn_config,
    'uvicorn.server': _patch_uvicorn_server,
    'gunicorn.arbiter': _patch_gunicorn_arbiter,
    'gunicorn.workers.base': _patch_gunicorn_worker,
    'waitress.server': _patch_waitress_server,
    'wsgiref.simple_server': _patch_wsgiref,
}




def install_hooks():
    _install_listening()
    for name, hook in SERVER_HOOKS.items():
        register(name, hook)
