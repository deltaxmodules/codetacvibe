"""Stage 7: network boundaries (spec 3.7), with the fields of src/boundaries.mjs.
Only the standard library here (http.client, urllib, smtplib); httpx, aiohttp,
botocore and the AI SDKs are tried in scripts/accept-python.mjs (rede)."""
import json
import os
import sys
import unittest

from helpers import SRC, Sandbox

sys.path.insert(0, SRC)
from codetac_py.network import ai_request_details, ai_response_details, classify_http  # noqa: E402

VECTORS = os.path.join(os.path.dirname(__file__), '..', 'vetores-http.json')

SERVERS = '''
import http.server, socketserver, threading, json

class Api(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        body = json.dumps({'ok': True}).encode()
        self.send_response(200)
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        self.rfile.read(int(self.headers['content-length']))
        body = json.dumps({'choices': [{'message': {'content': 'resposta'}}], 'usage': {'prompt_tokens': 3, 'completion_tokens': 2}}).encode()
        self.send_response(200)
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class Smtp(socketserver.StreamRequestHandler):
    def handle(self):
        self.wfile.write(b'220 ensaio\\r\\n')
        while True:
            line = self.rfile.readline()
            if not line:
                return
            command = line[:4].upper()
            if command == b'DATA':
                self.wfile.write(b'354 go\\r\\n')
                while self.rfile.readline() not in (b'.\\r\\n', b''):
                    pass
                self.wfile.write(b'250 aceite\\r\\n')
            elif command == b'RCPT' and b'recusado' in line:
                self.wfile.write(b'550 nao\\r\\n')
            elif command == b'QUIT':
                self.wfile.write(b'221 adeus\\r\\n')
                return
            else:
                self.wfile.write(b'250 ok\\r\\n')


def start(server):
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server.server_address[1]

api = start(http.server.ThreadingHTTPServer(('127.0.0.1', 0), Api))
smtp = start(socketserver.ThreadingTCPServer(('127.0.0.1', 0), Smtp))
'''

APP = SERVERS + '''
import http.client, smtplib, socket, urllib.request
from email.message import EmailMessage
from codetac_py import capture

def forecast():
    request = urllib.request.Request('http://127.0.0.1:%d/forecast?city=cidade-secreta' % api,
                                     headers={'Authorization': 'Bearer segredo-do-cabecalho-1234'})
    with urllib.request.urlopen(request) as response:
        return response.status

def ask_model():
    connection = http.client.HTTPConnection('127.0.0.1', api)
    connection.request('POST', '/v1/chat/completions', body=json.dumps({'model': 'modelo-x', 'messages': [{'role': 'user', 'content': 'pergunta'}]}),
                       headers={'content-type': 'application/json'})
    return connection.getresponse().read()

def unreachable():
    probe = socket.socket()
    probe.bind(('127.0.0.1', 0))
    port = probe.getsockname()[1]
    probe.close()
    try:
        urllib.request.urlopen('http://127.0.0.1:%d/x' % port, timeout=2)
    except OSError:
        return 'recusado'

def notify():
    message = EmailMessage()
    message['From'] = 'remetente-secreto@exemplo.pt'
    message['To'] = 'cliente@exemplo.pt, recusado@exemplo.pt'
    message['Subject'] = 'Assunto secreto'
    message.set_content('Corpo secreto da mensagem')
    with smtplib.SMTP('127.0.0.1', smtp) as client:
        return client.send_message(message)

def handler():
    print(forecast(), len(ask_model()) > 0, unreachable(), sorted(notify()))

scope = capture.request_scope('"py:r1"')
handler()
capture.current.reset(scope)
'''


class Vectors(unittest.TestCase):
    def test_vetores_partilhados_com_o_node(self):
        with open(VECTORS, encoding='utf-8') as file:
            vectors = json.load(file)
        for case in vectors['classificacao']:
            entry = case['entrada']
            with self.subTest(url=entry['url']):
                self.assertEqual(classify_http(entry['method'], entry['url'], entry['headers'], entry['body'], entry['client']), case['saida'])
        for case in vectors['pedidosIA']:
            with self.subTest(pedido=str(case['entrada'])[:60]):
                self.assertEqual(ai_request_details(case['entrada']), case['saida'])
        for case in vectors['respostasIA']:
            with self.subTest(resposta=case['entrada'][:60]):
                self.assertEqual(ai_response_details(case['entrada']), case['saida'])


class Network(Sandbox):
    def test_http_client_urllib_e_smtplib(self):
        result = self.run_script('main.py', APP)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "200 True recusado ['recusado@exemplo.pt']")
        events = self.events()
        calls = self.calls(events)
        starts = [event for event in events if event['type'] == 'boundary']
        ends = {event['id']: event for event in events if event['type'] == 'boundary-end'}
        by = {event['id']: event['function'] for event in events if event['type'] == 'enter'}
        summary = [(by[event['parentId']], event['kind'], event['library'], event.get('method'), event.get('path')) for event in starts]
        self.assertEqual(summary, [
            ('forecast', 'http', 'http.client', 'GET', '/forecast'),
            ('ask_model', 'ia', 'http.client', 'POST', '/v1/chat/completions'),
            ('unreachable', 'http', 'http.client', 'GET', '/x'),
            ('notify', 'email', 'smtplib', None, None),
        ])
        forecast, model, unreachable, mail = starts
        self.assertEqual((forecast['host'], forecast['queryKeys'], forecast['local']), ('127.0.0.1', ['city'], True))
        self.assertEqual({k: ends[forecast['id']][k] for k in ('status', 'error')}, {'status': 200, 'error': False})
        self.assertEqual((model['provider'], model['model']), ('local model', 'modelo-x'))
        # As in Node: the model and a short excerpt of the question (redacted when written).
        self.assertEqual({k: ends[model['id']].get(k) for k in ('status', 'model', 'promptExcerpt')},
                         {'status': 200, 'model': 'modelo-x', 'promptExcerpt': 'pergunta'})
        self.assertTrue(ends[unreachable['id']]['error'])
        # Email: the recipients redacted, their count, what was accepted.
        self.assertEqual((mail['to'], mail['count'], mail['provider']), (['c***@e***', 'r***@e***'], 2, 'SMTP'))
        self.assertEqual({k: ends[mail['id']][k] for k in ('accepted', 'rejected', 'error')}, {'accepted': 1, 'rejected': 1, 'error': False})
        self.assertEqual({event['requestId'] for event in starts}, {'py:r1'})
        self.assertTrue(calls['notify'])
        raw = self.raw()
        for value in ('segredo-do-cabecalho-1234', 'cidade-secreta', 'Authorization', 'remetente', 'Assunto secreto', 'Corpo secreto',
                      'cliente@exemplo.pt'):
            self.assertNotIn(value, raw)

    def test_fora_de_um_pedido_tambem_e_fronteira_e_sem_captor_nada_muda(self):
        # As the database boundaries: a call at start-up is recorded, with no request.
        source = SERVERS + '''
import urllib.request
print(urllib.request.urlopen('http://127.0.0.1:%d/' % api).status)
'''
        result = self.run_script('main.py', source)
        self.assertEqual(result.returncode, 0, result.stderr)
        boundaries = [event for event in self.events() if event['type'] == 'boundary']
        self.assertEqual([(event['kind'], event['requestId']) for event in boundaries], [('http', None)])
        result = self.run_script('main.py', source, run=None)
        self.assertEqual((result.returncode, result.stdout.strip()), (0, '200'), result.stderr)


if __name__ == '__main__':
    unittest.main()
