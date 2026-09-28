"""Stage 11: detail on request (detalhe.json, local LINE events, preview that
never runs code of the app)."""
import json
import os
import sys
import unittest

from helpers import Sandbox, line_of, write

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'python'))
from codetac_py.detail import preview  # noqa: E402

ran = []


class Bomb(object):
    """Every way an object can run code when it is looked at."""

    def __init__(self):
        self.visible = 1
        self._internal = 2

    @property
    def explodes(self):
        ran.append('property')
        raise RuntimeError('property')

    def __getattr__(self, name):
        ran.append('__getattr__')
        raise RuntimeError('__getattr__')

    def __getattribute__(self, name):
        if name not in ('__dict__', 'visible', '_internal'):
            ran.append('__getattribute__ ' + name)
        return object.__getattribute__(self, name)

    def __repr__(self):
        ran.append('__repr__')
        raise RuntimeError('__repr__')

    __str__ = __repr__

    @property
    def __class__(self):
        ran.append('__class__')
        return dict


class OwnDict(object):
    @property
    def __dict__(self):
        ran.append('__dict__ property')
        return {'x': 1}


class TrickyDict(dict):
    def items(self):
        ran.append('items')
        return []

    def keys(self):
        ran.append('keys')
        return []


class TrickyList(list):
    def __iter__(self):
        ran.append('__iter__')
        return iter([])

    def __len__(self):
        ran.append('__len__')
        return 0


class Failure(Exception):
    def __str__(self):
        ran.append('Exception.__str__')
        return 'segredo na mensagem'


class Slots(object):
    __slots__ = ('a',)

    def __init__(self):
        self.a = 1


class Preview(unittest.TestCase):
    def setUp(self):
        ran.clear()

    def test_preview_nao_executa_codigo_da_app(self):
        values = [Bomb(), OwnDict(), TrickyDict(a=1), TrickyList([1, 2]), Failure('x'), Slots(), {'bomb': Bomb()}]
        result = preview(values)
        self.assertEqual(ran, [])
        bomb, own, tricky_dict, tricky_list, failure, slots, nested = result
        self.assertEqual(bomb, {'$class': 'Bomb', 'visible': 1})
        self.assertEqual(own, {'$class': 'OwnDict', '$summarised': True})
        self.assertEqual(tricky_dict, {'$class': 'TrickyDict', 'a': 1})
        self.assertEqual(tricky_list, [1, 2])
        self.assertEqual(failure, {'$type': 'error', 'name': 'Failure'})
        self.assertEqual(slots, {'$class': 'Slots', '$summarised': True})
        self.assertEqual(nested, {'bomb': {'$class': 'Bomb', 'visible': 1}})

    def test_tipos_da_biblioteca_padrao_e_limites(self):
        import datetime
        import decimal
        import uuid
        from pathlib import Path
        result = preview({'data': datetime.date(2026, 9, 27), 'n': decimal.Decimal('1.50'), 'id': uuid.UUID(int=1), 'p': Path('/tmp/x'),
                          'b': b'abc', 'grande': 2 ** 70, 'nan': float('nan'), 'lista': list(range(25)), 'texto': 'x' * 2100,
                          'fundo': [[[[[1]]]]], 'conjunto': {3}, 'tupla': (1, 'a'), 'funcao': preview})
        self.assertEqual(result['data'], {'$type': 'date', 'value': '2026-09-27'})
        self.assertEqual(result['n'], {'$type': 'decimal', 'value': '1.50'})
        self.assertEqual(result['id'], {'$type': 'uuid', 'value': '00000000-0000-0000-0000-000000000001'})
        self.assertEqual(result['p'], {'$type': 'path', 'value': '/tmp/x'})
        self.assertEqual(result['b'], {'$type': 'bytes', 'bytes': 3})
        self.assertEqual((result['grande'], result['nan']), (str(2 ** 70), 'nan'))
        self.assertEqual(result['lista'][-1], {'$more': 5})
        self.assertTrue(result['texto'].endswith('[TRUNCATED 2100]'))
        self.assertEqual(result['fundo'], [[[{'$type': 'list', '$summarised': True}]]])
        self.assertEqual(result['conjunto'], {'$type': 'set', 'size': 1, 'values': [3]})
        self.assertEqual(result['tupla'], [1, 'a'])
        self.assertEqual(result['funcao'], {'$type': 'function', 'name': 'preview'})
        loop = []
        loop.append(loop)
        self.assertEqual(preview(loop), [{'$type': 'circular'}])

    def test_pedidos_http_resumidos(self):
        # Starlette and werkzeug requests, from their own fields: no values of
        # query, cookies or headers.
        starlette = type('Request', (), {'__module__': 'starlette.requests'})()
        starlette.scope = {'type': 'http', 'method': 'POST', 'path': '/notes', 'query_string': b'token=valor&x=1',
                           'headers': [(b'cookie', b'sessao=valor-secreto'), (b'content-type', b'application/json')]}
        werkzeug = type('Request', (), {'__module__': 'werkzeug.wrappers.request'})()
        werkzeug.environ = {'REQUEST_METHOD': 'GET', 'PATH_INFO': '/items', 'QUERY_STRING': 'q=valor', 'HTTP_COOKIE': 'valor-secreto'}
        result = preview([starlette, werkzeug])
        self.assertEqual(result[0], {'$class': 'Request', 'method': 'POST', 'path': '/notes?token=…&x=…', 'headers': ['cookie', 'content-type']})
        self.assertEqual(result[1], {'$class': 'Request', 'method': 'GET', 'path': '/items?q=…', 'headers': ['cookie']})
        self.assertNotIn('valor', json.dumps(result).replace('"valor"', ''))


APP = '''
import json, os, sys, time

def price(amount, rate=0.23, *extra, password=None, **options):
    total = amount * (1 + rate)
    if total > 100:
        total = round(total, 2)
    return total

def hash_password(secret):
    return 'h-' + secret

def broken(value):
    return value['falta']

def untouched(value):
    return value

def run():
    price(200, password='palavra-passe-de-ensaio')
    hash_password('outro-segredo-de-ensaio')
    untouched(1)
    try:
        broken({})
    except KeyError:
        pass

run()
# The panel turns detail on while the app runs: the next calls record values.
detail_file = sys.argv[1]
with open(detail_file, 'w') as file:
    json.dump({'functions': [{'file': os.path.abspath(__file__), 'line': int(sys.argv[2]), 'function': 'untouched'}], 'files': []}, file)
time.sleep(0.8)
untouched('depois')
'''


class DetailOnRequest(Sandbox):
    def run_app(self):
        path = write(self.project, 'main.py', APP)
        folder = os.path.join(self.home, 'ensaio')
        os.makedirs(folder)
        detail_file = os.path.join(folder, 'detalhe.json')
        with open(detail_file, 'w') as file:
            json.dump({'functions': [{'file': path, 'line': line_of(path, 'def price'), 'function': 'price'},
                                     {'file': path, 'line': line_of(path, 'def hash_password'), 'function': 'hash_password'},
                                     {'file': path, 'line': line_of(path, 'def broken'), 'function': 'broken'}], 'files': []}, file)
        result = self.run_python(None, 'ensaio', args=['main.py', detail_file, str(line_of(path, 'def untouched'))])
        self.assertEqual(result.returncode, 0, result.stderr)
        return path, self.events()

    def test_valores_linhas_e_redacao(self):
        path, events = self.run_app()
        names = {event['id']: event['function'] for event in events if event['type'] == 'enter'}
        details = {names[event['id']]: event for event in events if event['type'] == 'detail'}
        self.assertEqual(sorted(details), ['broken', 'hash_password', 'price', 'untouched'])
        price = details['price']
        self.assertEqual(price['args'], [{'name': 'amount', 'value': 200}, {'name': 'rate', 'value': 0.23}, {'name': 'extra', 'value': []},
                                         {'name': 'password', 'value': '[REDACTED]'}, {'name': 'options', 'value': {}}])
        self.assertEqual(price['returned'], 246.0)
        first = line_of(path, 'total = amount')
        self.assertEqual(price['lines'], [first, first + 1, first + 2, first + 3])
        # A function whose name announces a secret: its value is hidden too.
        self.assertEqual(details['hash_password']['returned'], '[REDACTED]')
        self.assertEqual(details['broken']['threw'], {'$type': 'error', 'name': 'KeyError'})
        self.assertNotIn('returned', details['broken'])
        # Detail switched on while the app ran: only the calls after it.
        self.assertEqual([arg['value'] for arg in details['untouched']['args']], ['depois'])
        self.assertEqual(len([name for name in names.values() if name == 'untouched']), 2)
        # The detail event comes before the exit of its call.
        exits = {event['id']: event['sequence'] for event in events if event['type'] == 'exit'}
        self.assertLess(price['sequence'], exits[price['id']])
        raw = self.raw()
        for secret in ('palavra-passe-de-ensaio', 'outro-segredo-de-ensaio'):
            self.assertNotIn(secret, raw)


if __name__ == '__main__':
    unittest.main()
