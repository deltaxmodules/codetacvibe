"""Stage 4: each HTTP request is a unit (spec 3.6), with the Node events."""
import json
import os
import unittest

from helpers import Sandbox
from test_sitecustomize import old_python

WSGI_APP = '''
import sys, threading, urllib.request
from wsgiref.simple_server import make_server, WSGIRequestHandler

class Quiet(WSGIRequestHandler):
    def log_message(self, *args):
        pass

def lookup(item):
    return item.upper()

def stream():
    yield chunk(b'a')
    yield chunk(b'b')

def chunk(data):
    return data

def app(environ, start_response):
    path = environ['PATH_INFO']
    if path == '/erro':
        raise RuntimeError('rebenta')
    if path == '/stream':
        start_response('200 OK', [('Content-Type', 'text/plain')])
        return stream()
    lookup(path)
    start_response('201 Created', [('Content-Type', 'text/plain'),
        ('Set-Cookie', 'session=valor-do-cookie-secreto; HttpOnly'),
        ('Set-Cookie', 'old=; Max-Age=0'),
        ('Set-Cookie', 'gone=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT')])
    return [b'ok']

server = make_server('127.0.0.1', 0, app, handler_class=Quiet)
port = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()

def get(path, headers=None):
    request = urllib.request.Request('http://127.0.0.1:%d%s' % (port, path), headers=headers or {})
    try:
        with urllib.request.urlopen(request) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code

statuses = [get('/items/abc?x=valor-da-query&y=2&x=3', {'Origin': 'http://127.0.0.1:5173'}), get('/stream'), get('/erro'),
            get('/items/interno', {'x-codetac-internal': '1'}),
            get('/pedido/tok_abcdefghij0123456789xyz')]
server.shutdown()
print(port, statuses)
'''


class Wsgi(Sandbox):
    def run_app(self, python=None, extra=None):
        from helpers import write
        write(self.project, 'main.py', WSGI_APP)
        result = self.run_python(None, 'ensaio', python=python, extra=extra, args=['main.py'])
        self.assertEqual(result.returncode, 0, result.stderr)
        port, statuses = result.stdout.strip().split(' ', 1)
        return int(port), statuses, self.events()

    def test_pedidos_wsgi(self):
        port, statuses, events = self.run_app()
        self.assertEqual(statuses, '[201, 200, 500, 201, 201]')
        requests = [event for event in events if event['type'] == 'request']
        ends = {event['requestId']: event for event in events if event['type'] == 'request-end'}
        # The internal request is not a unit.
        self.assertEqual([(event['method'], event['path'], event['queryKeys']) for event in requests], [
            ('GET', '/items/abc', ['x', 'y']), ('GET', '/stream', []), ('GET', '/erro', []), ('GET', '/pedido/[REDACTED]', [])])
        first, stream, error, opaque = requests
        self.assertEqual(first['requestId'], '%s:r1' % first['process'])
        # A page of another origin: origin and host recorded for the probable link (DP3).
        self.assertEqual((first['origin'], first['host']), ('http://127.0.0.1:5173', '127.0.0.1:%d' % port))
        self.assertNotIn('origin', stream)
        self.assertIsNone(first['parentId'])
        self.assertIsInstance(first['at'], int)
        self.assertEqual(ends[first['requestId']]['status'], 201)
        self.assertFalse(ends[first['requestId']]['aborted'])
        self.assertEqual(ends[first['requestId']]['cookies'], [
            {'name': 'session', 'cleared': False}, {'name': 'old', 'cleared': True}, {'name': 'gone', 'cleared': True}])
        self.assertEqual(ends[error['requestId']]['status'], 500)
        self.assertNotIn('cookies', ends[stream['requestId']])
        # Functions carry their request, also while the body streams.
        calls = self.calls(events)
        self.assertEqual([call['requestId'] for call in calls['lookup']], [first['requestId'], None, opaque['requestId']])
        self.assertEqual([call['requestId'] for call in calls['chunk']], [stream['requestId']] * 2)
        self.assertEqual(calls['stream'][0]['requestId'], stream['requestId'])
        self.assertEqual([call['requestId'] for call in calls['app']][:3], [first['requestId'], stream['requestId'], error['requestId']])
        self.assertEqual(len(calls['app']), 5)  # the internal request ran, unrecorded as a request
        self.assertIsNone(calls['app'][3]['requestId'])
        # No values: query, cookies, opaque path segment.
        raw = self.raw()
        for value in ('valor-da-query', 'valor-do-cookie-secreto', 'tok_abcdefghij0123456789xyz'):
            self.assertNotIn(value, raw)
        # The real port.
        listening = [event for event in events if event['type'] == 'listening']
        self.assertEqual([(event['port'], event['address']) for event in listening], [(port, '127.0.0.1')])
        # The server, for `codetac diagnostico`.
        self.assertEqual([event.get('server') for event in listening], ['wsgiref'])

    def test_modo_minimo_num_python_antigo_grava_pedidos_sem_funcoes(self):
        python = old_python()
        if not python:
            self.skipTest('não há nenhum Python abaixo de 3.12 nesta máquina')
        port, statuses, events = self.run_app(python=python)
        self.assertEqual(statuses, '[201, 200, 500, 201, 201]')
        self.assertEqual(events[0]['level'], 'minimo')
        self.assertEqual(len([event for event in events if event['type'] == 'request']), 4)
        self.assertEqual([event for event in events if event['type'] == 'enter'], [])
        self.assertIn(port, [event['port'] for event in events if event['type'] == 'listening'])


# Like werkzeug after a POST from a browser: the body is sent whole, and
# close() comes much later (the server first drains the socket).
LATE_CLOSE = '''
import json
from codetac_py.servers import wrap_wsgi

def teardown():
    return 1

class Body(list):
    def close(self):
        teardown()

def app(environ, start_response):
    start_response('302 FOUND', [('Location', '/items'), ('Content-Length', '2')])
    return Body([b'ok'])

body = wrap_wsgi(app)({'REQUEST_METHOD': 'POST', 'PATH_INFO': '/login'}, lambda status, headers, exc_info=None: None)
print(json.dumps([chunk.decode() for chunk in body]))
import codetac_py
codetac_py.writer.emit({'type': 'marca'})
body.close()
'''


class LateClose(Sandbox):
    def test_pedido_termina_quando_o_corpo_foi_enviado(self):
        result = self.run_script('main.py', LATE_CLOSE)
        self.assertEqual(result.returncode, 0, result.stderr)
        events = self.events()
        kinds = [event.get('function', event['type']) for event in events
                 if event['type'] in ('request-end', 'marca') or event.get('function') in ('app', 'teardown')]
        # The end before close() is called; teardown still belongs to the request, after its end.
        self.assertEqual(kinds, ['app', 'request-end', 'marca', 'teardown'])
        end = next(event for event in events if event['type'] == 'request-end')
        self.assertEqual((end['status'], end['aborted']), (302, False))
        teardown = self.calls(events)['teardown'][0]
        self.assertEqual(teardown['requestId'], end['requestId'])
        # Stage 9: after the response, marked.
        self.assertTrue(teardown['afterResponse'])
        self.assertNotIn('afterResponse', self.calls(events)['app'][0])


class CrossOrigin(unittest.TestCase):
    def test_origem_diferente(self):
        import sys
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'python'))
        from codetac_py.servers import cross_origin
        self.assertEqual(cross_origin('http://127.0.0.1:5173', '127.0.0.1:8000'), ('http://127.0.0.1:5173', '127.0.0.1:8000'))
        for origin, host in (('http://127.0.0.1:8000', '127.0.0.1:8000'), ('null', 'x:1'), (None, 'x:1'), ('http://a:1', None),
                             ('file:///x', 'x:1'), ('não é url', 'x:1')):
            self.assertIsNone(cross_origin(origin, host), (origin, host))


ASGI_APP = '''
import asyncio, json, sys
from codetac_py.servers import wrap_asgi

def compute():
    return 1

def after_response():
    return 2

def between_chunks():
    return 3

async def app(scope, receive, send):
    if scope['type'] == 'lifespan':
        message = await receive()
        await send({'type': 'lifespan.startup.complete'})
        return
    if scope['type'] == 'websocket':
        await send({'type': 'websocket.accept'})
        return
    if scope['path'] == '/falha':
        raise RuntimeError('antes da resposta')
    compute()
    await send({'type': 'http.response.start', 'status': 200,
                'headers': [(b'content-type', b'text/plain'), (b'set-cookie', b'token=valor-secreto; Path=/')]})
    await send({'type': 'http.response.body', 'body': b'a', 'more_body': True})
    between_chunks()
    await send({'type': 'http.response.body', 'body': b'b'})
    after_response()

async def main():
    wrapped = wrap_asgi(app)
    sent = []
    async def send(message):
        sent.append(message['type'])
    async def receive():
        return {'type': 'lifespan.startup'}
    for scope in ({'type': 'lifespan'}, {'type': 'websocket', 'path': '/ws'},
                  {'type': 'http', 'method': 'POST', 'path': '/notas/1', 'raw_path': b'/notas/1', 'query_string': b'q=segredo&page=2', 'headers': []},
                  {'type': 'http', 'method': 'GET', 'path': '/interno', 'query_string': b'', 'headers': [(b'x-codetac-internal', b'1')]}):
        await wrapped(scope, receive, send)
    try:
        await wrapped({'type': 'http', 'method': 'GET', 'path': '/falha', 'query_string': b'', 'headers': []}, receive, send)
    except RuntimeError:
        pass
    print(json.dumps(sent))

asyncio.run(main())
'''


class Asgi(Sandbox):
    def test_pedidos_asgi_lifespan_e_websocket(self):
        result = self.run_script('main.py', ASGI_APP)
        self.assertEqual(result.returncode, 0, result.stderr)
        # Lifespan and websocket reach the app unchanged, and are not requests.
        # The internal request also reaches the app, it is just not a request of the dossier.
        body = ['http.response.start', 'http.response.body', 'http.response.body']
        self.assertEqual(json.loads(result.stdout), ['lifespan.startup.complete', 'websocket.accept'] + body + body)
        events = self.events()
        requests = [event for event in events if event['type'] == 'request']
        self.assertEqual([(event['method'], event['path'], event['queryKeys']) for event in requests],
                         [('POST', '/notas/1', ['q', 'page']), ('GET', '/falha', [])])
        ends = [event for event in events if event['type'] == 'request-end']
        self.assertEqual([(event['status'], event['aborted']) for event in ends], [(200, False), (None, True)])
        self.assertEqual(ends[0]['cookies'], [{'name': 'token', 'cleared': False}])
        calls = self.calls(events)
        self.assertEqual(calls['compute'][0]['requestId'], requests[0]['requestId'])
        # Work after the response still belongs to the request, and comes after request-end.
        after = calls['after_response'][0]
        self.assertEqual(after['requestId'], requests[0]['requestId'])
        # Stage 9: marked afterResponse (enter and exit); what ran before the end is not.
        self.assertTrue(after['afterResponse'])
        self.assertTrue(next(event for event in events if event['type'] == 'exit' and event['id'] == after['id'])['afterResponse'])
        for name in ('compute', 'between_chunks'):
            self.assertNotIn('afterResponse', calls[name][0])
        self.assertGreater(after['sequence'], ends[0]['sequence'])
        # The request ends with the last chunk of the body, not the first.
        self.assertLess(calls['between_chunks'][0]['sequence'], ends[0]['sequence'])
        self.assertNotIn('segredo', self.raw())


if __name__ == '__main__':
    unittest.main()
