"""Stage 8: the bar in the page (spec 3.6), its routes, the action of each request,
and the lines of Jinja templates (spec 3.3)."""
import glob
import json
import os
import unittest

from helpers import Sandbox, line_of, write

WSGI_APP = r'''
import gzip, json, sys, threading, urllib.request
from wsgiref.simple_server import make_server, WSGIRequestHandler
from wsgiref.util import FileWrapper

class Quiet(WSGIRequestHandler):
    def log_message(self, *args):
        pass

PAGE = b'<!doctype html><html><head><title>t</title></head><body>ola</body></html>'
reached = []
closed = []

class Body(list):
    def close(self):
        closed.append(True)

def render():
    return PAGE

def app(environ, start_response):
    path = environ['PATH_INFO']
    reached.append(path)
    html = [('Content-Type', 'text/html; charset=utf-8')]
    if path == '/pagina':
        body = render()
        start_response('200 OK', html + [('Content-Length', str(len(body))), ('ETag', '"v1"')])
        return Body([body])
    if path == '/codificacao':
        body = PAGE if environ.get('HTTP_ACCEPT_ENCODING') is None else b'<html><head></head>pediu compressao</html>'
        start_response('200 OK', html + [('Content-Length', str(len(body)))])
        return [body]
    if path == '/gzip':
        body = gzip.compress(PAGE)
        start_response('200 OK', html + [('Content-Length', str(len(body))), ('Content-Encoding', 'gzip')])
        return [body]
    if path == '/stream':
        start_response('200 OK', html)
        return iter([b'<html><head>', b'</head>parte</html>'])
    if path == '/erro':
        body = b'<html><head></head><body>500</body></html>'
        start_response('500 INTERNAL SERVER ERROR', html + [('Content-Length', str(len(body)))])
        return [body]
    if path == '/fragmento':
        start_response('200 OK', html + [('Content-Length', '10')])
        return [b'<li>x</li>']
    if path == '/sem-head':
        start_response('200 OK', html)
        return [b'<html><body>so body</body></html>']
    if path == '/ficheiro':
        start_response('200 OK', html + [('Content-Length', str(len(PAGE)))])
        import io
        return FileWrapper(io.BytesIO(PAGE))
    if path == '/depurador':
        # Like the werkzeug debugger: start_response is called while the body is iterated.
        def body():
            start_response('500 INTERNAL SERVER ERROR', html + [('Content-Length', str(len(PAGE)))])
            yield PAGE
        return body()
    if path == '/json':
        start_response('200 OK', [('Content-Type', 'application/json'), ('Content-Length', '2')])
        return [b'{}']
    start_response('204 No Content', [])
    return []

server = make_server('127.0.0.1', 0, app, handler_class=Quiet)
port = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()

def call(path, headers=None, method='GET', data=None):
    request = urllib.request.Request('http://127.0.0.1:%d%s' % (port, path), headers=headers or {}, method=method, data=data)
    try:
        response = urllib.request.urlopen(request)
    except urllib.error.HTTPError as error:
        response = error
    body = response.read()
    return {'status': response.status, 'body': body.decode('latin-1'), 'headers': dict((k.lower(), v) for k, v in response.headers.items())}

document = {'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'accept-encoding': 'gzip'}
result = {}
for path in ('/pagina', '/codificacao', '/gzip', '/stream', '/erro', '/fragmento', '/sem-head', '/ficheiro', '/depurador', '/json'):
    result[path] = call(path, document)
result['fetch'] = call('/pagina', {'sec-fetch-dest': 'empty', 'accept': 'text/html'})
result['accept'] = call('/pagina', {'accept': 'text/html,application/xhtml+xml'})
result['post'] = call('/pagina', dict(document), 'POST', b'x=1')
result['bar'] = call('/__codetac/bar.js')
result['unknown'] = call('/__codetac/outra')
host = '127.0.0.1:%d' % port
action = {'actionId': 'acao-123456', 'segment': 1, 'page': 'http://%s/items?nome=valor-da-pagina' % host, 'trigger': {'event': 'click',
          'element': {'tag': 'button', 'text': 'Guardar', 'href': '/x?token=valor-do-link'}, 'extra': 'ignorado'},
          'requests': [{'n': 1, 'method': 'POST', 'url': 'http://%s/items?q=valor-do-pedido' % host, 'sameOrigin': True, 'status': 302}],
          'screen': {'added': 2, 'title': True}, 'closedBy': 'navegacao', 'desconhecido': 'valor-desconhecido'}
body = json.dumps(action).encode()
result['events'] = call('/__codetac/events', {'origin': 'http://' + host, 'content-type': 'application/json'}, 'POST', body)
result['foreign'] = call('/__codetac/events', {'origin': 'http://outro.exemplo', 'content-type': 'application/json'}, 'POST', body)
result['large'] = call('/__codetac/events', {'origin': 'http://' + host}, 'POST', b'x' * (65 * 1024))
result['header'] = call('/json', {'x-codetac-action': 'acao-123456.3'})
result['cookie'] = call('/pagina', dict(document, cookie='a=1; codetac_action=acao-navegacao'))
result['cookie-fetch'] = call('/json', {'cookie': 'codetac_action=acao-navegacao', 'sec-fetch-mode': 'cors'})
server.shutdown()
print(json.dumps({'result': result, 'reached': reached, 'closed': len(closed), 'port': port}))
'''

TAG = '<script src="/__codetac/bar.js" data-codetac=""></script>'
PAGE = '<!doctype html><html><head><title>t</title></head><body>ola</body></html>'


class Vectors(unittest.TestCase):
    def test_vetores_partilhados_com_o_node(self):
        import sys
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'python'))
        from codetac_py.page import TAG as tag, insert_tag
        with open(os.path.join(os.path.dirname(__file__), '..', 'vetores-pagina.json'), encoding='utf-8') as file:
            vectors = json.load(file)['vetores']
        for vector in vectors:
            html = vector['html'].encode('utf-8')
            at = vector['posicao']
            self.assertEqual(insert_tag(html, True), html if at < 0 else html[:at] + tag + html[at:], vector['html'])
        self.assertIsNone(insert_tag(b'<!doctype html><html><he', False))


class WsgiPage(Sandbox):
    def run_app(self, extra=None):
        write(self.project, 'main.py', WSGI_APP)
        result = self.run_python(None, 'ensaio', extra=extra, args=['main.py'])
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_barra_nas_paginas_e_respostas_intactas(self):
        output = self.run_app({'CODETAC_PANEL_PORT': '4555'})
        result = output['result']
        page = result['/pagina']
        with_tag = PAGE.replace('<head>', '<head>' + TAG)
        self.assertEqual(page['body'], with_tag)
        self.assertEqual(page['headers']['content-length'], str(len(with_tag)))
        self.assertNotIn('etag', page['headers'])
        self.assertEqual(output['closed'], 5)  # the body's close() is still called (5 requests to /pagina)
        # Pages are asked for uncompressed.
        self.assertEqual(result['/codificacao']['body'], PAGE.replace('<head>', '<head>' + TAG))
        # Error pages too; and a body given while it is iterated (werkzeug debugger).
        self.assertEqual(result['/erro']['status'], 500)
        self.assertIn(TAG, result['/erro']['body'])
        self.assertEqual(result['/depurador']['body'], with_tag)
        self.assertEqual(result['/depurador']['headers']['content-length'], str(len(with_tag)))
        # Before <body> when there is no head; the whole list is the body.
        self.assertEqual(result['/sem-head']['body'], '<html>' + TAG + '<body>so body</body></html>')
        # Untouched: compressed, streamed, files, fragments, other types, fetch and POST.
        import gzip
        self.assertEqual(gzip.decompress(result['/gzip']['body'].encode('latin-1')).decode(), PAGE)
        self.assertEqual(result['/stream']['body'], '<html><head></head>parte</html>')
        self.assertEqual(result['/ficheiro']['body'], PAGE)
        self.assertEqual(result['/ficheiro']['headers']['content-length'], str(len(PAGE)))
        self.assertEqual(result['/fragmento']['body'], '<li>x</li>')
        self.assertEqual(result['/json']['body'], '{}')
        self.assertEqual(result['fetch']['body'], PAGE)
        self.assertEqual(result['post']['body'], PAGE)
        self.assertEqual(result['post']['headers']['etag'], '"v1"')
        # Without sec-fetch-dest (older browsers), Accept decides.
        self.assertEqual(result['accept']['body'], with_tag)
        # A `page` event per document asked for.
        events = self.events()
        pages = [event['path'] for event in events if event['type'] == 'page']
        self.assertEqual(pages, ['/pagina', '/codificacao', '/gzip', '/stream', '/erro', '/fragmento', '/sem-head', '/ficheiro',
                                 '/depurador', '/json', '/pagina', '/pagina'])
        self.assertIn('render', self.calls(events))

    def test_rotas_proprias_nao_chegam_a_app(self):
        output = self.run_app({'CODETAC_PANEL_PORT': '4555'})
        result = output['result']
        self.assertTrue(all(not path.startswith('/__codetac/') for path in output['reached']))
        bar = result['bar']
        self.assertEqual(bar['status'], 200)
        self.assertEqual(bar['headers']['content-type'], 'text/javascript; charset=utf-8')
        self.assertTrue(bar['body'].startswith('window.__CODETAC_CONFIG__={"panel":"http://127.0.0.1:4555","run":"ensaio"};\n'))
        with open(os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'browser', 'bar.js'), encoding='utf-8') as file:
            self.assertTrue(bar['body'].encode('latin-1').decode('utf-8').endswith(file.read()))
        self.assertEqual(result['unknown']['status'], 404)
        self.assertEqual([result[name]['status'] for name in ('events', 'foreign', 'large')], [204, 403, 413])
        events = self.events()
        # Own routes are not requests of the dossier.
        self.assertFalse(any(event['type'] == 'request' and event['path'].startswith('/__codetac/') for event in events))
        actions = [event for event in events if event['type'] == 'browser-action']
        self.assertEqual(len(actions), 1)
        action = actions[0]
        self.assertEqual(action['actionId'], 'acao-123456')
        self.assertEqual(action['page'], {'path': '/items', 'queryKeys': ['nome']})
        self.assertEqual(action['trigger'], {'event': 'click', 'element': {'tag': 'button', 'text': 'Guardar', 'href': '/x'}})
        self.assertEqual(action['requests'], [{'n': 1, 'method': 'POST', 'path': '/items', 'queryKeys': ['q'], 'sameOrigin': True, 'status': 302}])
        self.assertEqual(action['screen'], {'added': 2, 'title': True})
        raw = self.raw()
        for value in ('valor-da-pagina', 'valor-do-link', 'valor-do-pedido', 'valor-desconhecido', 'ignorado'):
            self.assertNotIn(value, raw)

    def test_acao_por_cabecalho_e_por_cookie_de_continuacao(self):
        self.run_app()
        requests = [event for event in self.events() if event['type'] == 'request']
        header = [event for event in requests if event.get('action') == 'acao-123456']
        self.assertEqual([(event['path'], event['actionRequest']) for event in header], [('/json', 3)])
        # The cookie counts only for a navigation (a new document).
        cookie = [event for event in requests if event.get('action') == 'acao-navegacao']
        self.assertEqual([event['path'] for event in cookie], ['/pagina'])
        self.assertNotIn('actionRequest', cookie[0])
        self.assertFalse(any('action' in event for event in requests if event not in header + cookie))

    def test_sem_barra_com_codetac_page_0(self):
        output = self.run_app({'CODETAC_PAGE': '0'})
        self.assertEqual(output['result']['/pagina']['body'], PAGE)
        self.assertEqual(output['result']['bar']['status'], 200)
        self.assertFalse(any(event['type'] == 'page' for event in self.events()))


ASGI_APP = r'''
import asyncio, json
from codetac_py.servers import wrap_asgi

PAGE = b'<!doctype html><html><head><title>t</title></head><body>ola</body></html>'
seen = {}

async def app(scope, receive, send):
    path = scope['path']
    seen[path] = [key for key, _ in scope['headers']]
    html = [(b'content-type', b'text/html; charset=utf-8')]
    if path == '/pagina':
        await send({'type': 'http.response.start', 'status': 200,
                    'headers': html + [(b'content-length', str(len(PAGE)).encode()), (b'etag', b'"v1"')]})
        await send({'type': 'http.response.body', 'body': PAGE[:20], 'more_body': True})
        await send({'type': 'http.response.body', 'body': PAGE[20:]})
    elif path == '/stream':
        await send({'type': 'http.response.start', 'status': 200, 'headers': html})
        await send({'type': 'http.response.body', 'body': b'<html><head>', 'more_body': True})
        await send({'type': 'http.response.body', 'body': b'</head></html>'})
    elif path == '/gzip':
        await send({'type': 'http.response.start', 'status': 200, 'headers': html + [(b'content-encoding', b'gzip'), (b'content-length', b'3')]})
        await send({'type': 'http.response.body', 'body': b'abc'})
    elif path == '/erro':
        body = b'<html><head></head>Internal Server Error</html>'
        await send({'type': 'http.response.start', 'status': 500, 'headers': html + [(b'content-length', str(len(body)).encode())]})
        await send({'type': 'http.response.body', 'body': body})

async def call(wrapped, path, headers, method='GET', body=b''):
    sent = []
    async def send(message):
        sent.append(message)
    async def receive():
        return {'type': 'http.request', 'body': body, 'more_body': False}
    scope = {'type': 'http', 'method': method, 'path': path, 'raw_path': path.encode(), 'query_string': b'', 'headers': headers}
    await wrapped(scope, receive, send)
    start = next(message for message in sent if message['type'] == 'http.response.start')
    return {'status': start['status'], 'headers': {key.decode(): value.decode() for key, value in start['headers']},
            'body': b''.join(message.get('body', b'') for message in sent if message['type'] == 'http.response.body').decode(),
            'messages': len(sent)}

async def main():
    wrapped = wrap_asgi(app)
    document = [(b'sec-fetch-dest', b'document'), (b'accept-encoding', b'gzip, br'), (b'host', b'127.0.0.1:8000')]
    result = {}
    for path in ('/pagina', '/stream', '/gzip', '/erro'):
        result[path] = await call(wrapped, path, document)
    result['fetch'] = await call(wrapped, '/pagina', [(b'sec-fetch-dest', b'empty')])
    result['bar'] = await call(wrapped, '/__codetac/bar.js', [])
    action = json.dumps({'actionId': 'acao-assincrona', 'requests': []}).encode()
    result['events'] = await call(wrapped, '/__codetac/events', [(b'origin', b'http://127.0.0.1:8000'), (b'host', b'127.0.0.1:8000')], 'POST', action)
    result['foreign'] = await call(wrapped, '/__codetac/events', [(b'origin', b'http://outro'), (b'host', b'127.0.0.1:8000')], 'POST', action)
    result['action'] = await call(wrapped, '/stream', [(b'x-codetac-action', b'acao-assincrona.2')])
    for item in result.values():
        if item['body'].startswith('window.'):
            item['body'] = item['body'][:40]
    print(json.dumps({'result': result, 'seen': {path: [key.decode() for key in keys] for path, keys in seen.items()}}))

asyncio.run(main())
'''


class AsgiPage(Sandbox):
    def test_barra_nas_paginas_asgi(self):
        result = self.run_script('main.py', ASGI_APP)
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        result = output['result']
        with_tag = PAGE.replace('<head>', '<head>' + TAG)
        page = result['/pagina']
        self.assertEqual(page['body'], with_tag)
        self.assertEqual(page['headers']['content-length'], str(len(with_tag)))
        self.assertNotIn('etag', page['headers'])
        self.assertNotIn('accept-encoding', output['seen']['/pagina'])
        self.assertIn(TAG, result['/erro']['body'])
        # Streams (no length) and compressed bodies pass untouched, message by message.
        self.assertEqual(result['/stream']['body'], '<html><head></head></html>')
        self.assertEqual(result['/stream']['messages'], 3)
        self.assertEqual(result['/gzip']['body'], 'abc')
        self.assertEqual(result['fetch']['body'], PAGE)
        self.assertEqual(result['fetch']['headers']['etag'], '"v1"')
        self.assertEqual(result['bar']['status'], 200)
        self.assertTrue(result['bar']['body'].startswith('window.__CODETAC_CONFIG__'))
        self.assertNotIn('/__codetac/bar.js', output['seen'])
        self.assertEqual([result['events']['status'], result['foreign']['status']], [204, 403])
        events = self.events()
        self.assertEqual([event['actionId'] for event in events if event['type'] == 'browser-action'], ['acao-assincrona'])
        requests = [event for event in events if event['type'] == 'request']
        self.assertEqual([(event['path'], event.get('action'), event.get('actionRequest')) for event in requests][-1],
                         ('/stream', 'acao-assincrona', 2))
        self.assertEqual([event['path'] for event in events if event['type'] == 'page'], ['/pagina', '/stream', '/gzip', '/erro'])


# Code compiled as Jinja compiles a template: the file name is the template's,
# the lines are those of the generated module, and `debug_info` maps them.
FAKE_TEMPLATE = r'''
import os, sys
TEMPLATE = os.path.join(os.getcwd(), 'templates', 'lista.html')
GENERATED = """def root(context):
    if 0: yield None
    parent = 1
    yield from context['blocks']['conteudo'](context)

def block_conteudo(context):
    if 0: yield None
    yield '<h1>'
    for item in context['items']:
        yield item
    yield '</h1>'

blocks = {'conteudo': block_conteudo}
debug_info = %r
"""

def render(table, name='lista.html'):
    namespace = {'environment': object(), '__file__': TEMPLATE, 'name': name}
    exec(compile(GENERATED % table, TEMPLATE, 'exec'), namespace)
    namespace['__jinja_template__'] = object()
    context = {'blocks': namespace['blocks'], 'items': ['a', 'b']}
    return ''.join(namespace['root'](context))

def view(table):
    return render(table)

print(view(sys.argv[1]))
'''

TEMPLATE = '''{% extends 'base.html' %}
{% block conteudo %}
<h1>
{% for item in items %}{{ item }}{% endfor %}
</h1>
{% endblock %}
'''


class JinjaLines(Sandbox):
    def render(self, table, run='ensaio'):
        write(self.project, 'templates/lista.html', TEMPLATE)
        write(self.project, 'main.py', FAKE_TEMPLATE)
        result = self.run_python(None, run, args=['main.py', table])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), '<h1>ab</h1>')
        return self.events(run)

    def test_linhas_do_template(self):
        # template line 1 -> generated line 3; block at line 2 -> its def (6); the loop (4) -> 9.
        events = self.render('1=3&2=6&3=8&4=9&5=11')
        calls = self.calls(events)
        template = os.path.join(self.project, 'templates', 'lista.html')
        root = calls['template lista.html'][0]
        block = calls['block conteudo (lista.html)'][0]
        self.assertEqual((root['file'], root['line'], root['endLine'], root['mapped']), (template, 1, 1, True))
        self.assertEqual((block['file'], block['line'], block['endLine'], block['mapped']), (template, 2, 5, True))
        self.assertEqual(line_of(template, '{% block conteudo %}'), 2)
        # Parentage: view -> template -> block.
        view = calls['view'][0]
        self.assertEqual(calls['render'][0]['parentId'], view['id'])
        self.assertEqual(root['parentId'], calls['render'][0]['id'])
        self.assertEqual(block['parentId'], root['id'])
        exits = {event['id'] for event in events if event['type'] == 'exit'}
        self.assertTrue({root['id'], block['id']} <= exits)
        self.assertFalse(any(event['type'] == 'limitation' for event in events))

    def test_mapeamento_que_falha_e_um_passo_opaco(self):
        # A table that points past the end of the file, and one that cannot be read.
        for run, table in (('fora', '1=3&2=6&40=9'), ('ilegivel', 'x=y')):
            events = self.render(table, run)
            calls = self.calls(events)
            self.assertEqual(sorted(calls), ['render', 'template lista.html', 'view'], run)
            root = calls['template lista.html'][0]
            self.assertEqual((root['line'], root['endLine'], root['mapped']), (None, None, False))
            limitations = [event for event in events if event['type'] == 'limitation']
            self.assertEqual([(event['reason'], event['file']) for event in limitations],
                             [('template-lines-unmapped', os.path.join(self.project, 'templates', 'lista.html'))])

    def test_template_alterado_depois_de_compilado_e_opaco(self):
        # Jinja says the file changed since it was compiled: its lines are not used.
        write(self.project, 'templates/lista.html', TEMPLATE)
        write(self.project, 'main.py', FAKE_TEMPLATE.replace("namespace['__jinja_template__'] = object()",
                                                             "namespace['__jinja_template__'] = type('T', (), {'is_up_to_date': False})()"))
        result = self.run_python(None, 'ensaio', args=['main.py', '1=3&2=6'])
        self.assertEqual(result.returncode, 0, result.stderr)
        root = self.calls(self.events())['template lista.html'][0]
        self.assertEqual((root['line'], root['mapped']), (None, False))

    def test_templates_das_bibliotecas_nao_aparecem(self):
        write(self.project, '.venv/pyvenv.cfg', '')
        write(self.project, '.venv/lib/templates/lista.html', TEMPLATE)
        write(self.project, 'main.py', FAKE_TEMPLATE.replace("'templates', 'lista.html'", "'.venv', 'lib', 'templates', 'lista.html'"))
        result = self.run_python(None, 'ensaio', args=['main.py', '1=3&2=6'])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sorted(self.calls(self.events())), ['render', 'view'])


def jinja_site_packages():
    root = os.path.join(os.path.dirname(__file__), '..', '..', 'fixtures', 'python', 'flask-sqlite', '.venv', 'lib')
    found = glob.glob(os.path.join(root, 'python3.*', 'site-packages', 'jinja2'))
    return os.path.dirname(found[0]) if found else None


REAL_JINJA = r'''
from jinja2 import Environment, FileSystemLoader

def ajuda():
    return 'ajuda'

def depois():
    return 'depois'

def view():
    environment = Environment(loader=FileSystemLoader('templates'))
    environment.globals['ajuda'] = ajuda
    html = environment.get_template('filho.html').render(items=['a', 'b'])
    depois()
    return html

print(view().split())
'''


@unittest.skipUnless(jinja_site_packages(), 'sem o Jinja do exemplo fixtures/python/flask-sqlite (.venv)')
class RealJinja(Sandbox):
    def test_jinja_verdadeiro(self):
        # The Jinja of the example is a library, outside the project.
        os.symlink(os.path.join(jinja_site_packages(), 'jinja2'), os.path.join(self.libs, 'jinja2'))
        os.symlink(os.path.join(jinja_site_packages(), 'markupsafe'), os.path.join(self.libs, 'markupsafe'))
        write(self.project, 'templates/base.html', '<html>\n<body>\n{% block conteudo %}{% endblock %}\n</body>\n</html>\n')
        write(self.project, 'templates/filho.html', TEMPLATE.replace('</h1>\n{% endblock %}', '</h1>\n{{ linha(1) }}\n{{ ajuda() }}\n{% endblock %}')
              + '{% macro linha(x) %}\n<p>{{ x }}</p>\n{% endmacro %}\n')
        result = self.run_script('main.py', REAL_JINJA)
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls(self.events())
        places = sorted((name, call['file'].split(os.sep)[-1], call['line'], call['endLine']) for name, items in calls.items()
                        for call in items[:1] if call['file'].endswith('.html'))
        # Jinja records the lines of its statements, not of plain text: the block
        # ends at its last statement (6, the macro call); the body of filho.html
        # defines the macro (8), which is shown at its own lines.
        self.assertEqual(places, [('block conteudo (filho.html)', 'filho.html', 2, 7), ('macro (filho.html)', 'filho.html', 9, 10),
                                  ('template base.html', 'base.html', 1, 3), ('template filho.html', 'filho.html', 1, 9)])
        self.assertEqual(calls['macro (filho.html)'][0]['parentId'], calls['block conteudo (filho.html)'][0]['id'])
        base = calls['template base.html'][0]
        self.assertEqual(calls['block conteudo (filho.html)'][0]['parentId'], base['id'])
        self.assertEqual(calls['template filho.html'][0]['parentId'], calls['view'][0]['id'])
        # The yields of a template are not followed (it is consumed whole): a function of the
        # project it calls, after HTML already yielded, is still the block's; and after the
        # render, the view's context is back.
        self.assertEqual(calls['ajuda'][0]['parentId'], calls['block conteudo (filho.html)'][0]['id'])
        self.assertEqual(calls['depois'][0]['parentId'], calls['view'][0]['id'])
        self.assertFalse(any('site-packages' in call['file'] for items in calls.values() for call in items))


if __name__ == '__main__':
    unittest.main()
