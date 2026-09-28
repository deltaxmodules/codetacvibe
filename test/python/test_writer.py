"""Stage 2: the last batch is never lost at the end (spec 3.4)."""
import glob
import json
import os
import signal
import unittest

from helpers import Sandbox

# Each script first makes the writer's timer 60 s long, and waits for it to
# start that wait: whatever reaches the file afterwards was written by the exit or
# signal path under test, never by the timer. `pending()` proves it.
PREAMBLE = '''
import os, signal, sys, time
import codetac_py
codetac_py.writer.flush_seconds = 60
time.sleep(0.1)  # the writer's thread ends its 25 ms wait and starts a 60 s one

def pending():
    return len(codetac_py.writer.queue) > 0

def last_work():
    return 42
'''


class Endings(Sandbox):
    def ending(self, body):
        result = self.run_script('main.py', PREAMBLE + body)
        names = [event.get('function') for event in self.events() if event['type'] == 'enter']
        return result, names

    def test_sigterm_sem_handler_da_app(self):
        result, names = self.ending('''
last_work()
print('pendente', pending(), flush=True)
os.kill(os.getpid(), signal.SIGTERM)
time.sleep(5)
print('não devia chegar aqui')
''')
        self.assertEqual(result.returncode, -signal.SIGTERM)
        self.assertEqual(result.stdout.strip(), 'pendente True')
        self.assertIn('last_work', names)

    def test_sigterm_com_handler_da_app_instalado_depois(self):
        result, names = self.ending('''
def on_term(number, frame):
    print('handler da app', flush=True)
    os._exit(3)

signal.signal(signal.SIGTERM, on_term)
print('getsignal', signal.getsignal(signal.SIGTERM) is on_term, flush=True)
last_work()
print('pendente', pending(), flush=True)
os.kill(os.getpid(), signal.SIGTERM)
time.sleep(5)
''')
        self.assertEqual(result.returncode, 3)
        self.assertEqual(result.stdout.split(), ['getsignal', 'True', 'pendente', 'True', 'handler', 'da', 'app'])
        self.assertIn('last_work', names)

    def test_handler_reposto_pela_app_volta_ao_comportamento_normal(self):
        # The uvicorn pattern: keep the previous handler, restore it at the end.
        result, names = self.ending('''
previous = signal.signal(signal.SIGTERM, lambda number, frame: None)
print('anterior', previous == signal.SIG_DFL, flush=True)
signal.signal(signal.SIGTERM, previous)
last_work()
os.kill(os.getpid(), signal.SIGTERM)
time.sleep(5)
''')
        self.assertEqual(result.returncode, -signal.SIGTERM)
        self.assertEqual(result.stdout.strip(), 'anterior True')
        self.assertIn('last_work', names)

    def test_sigint_por_omissao_continua_a_dar_keyboardinterrupt(self):
        result, names = self.ending('''
last_work()
try:
    os.kill(os.getpid(), signal.SIGINT)
    time.sleep(5)
except KeyboardInterrupt:
    # Read without calling project functions: the signal already flushed.
    print('KeyboardInterrupt', '"last_work"' in open(codetac_py.writer.file).read(), flush=True)
''')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'KeyboardInterrupt True')
        self.assertIn('last_work', names)

    def test_sinal_ignorado_continua_ignorado(self):
        result, _ = self.ending('''
signal.signal(signal.SIGHUP, signal.SIG_IGN)
os.kill(os.getpid(), signal.SIGHUP)
time.sleep(0.1)
print('continua', signal.getsignal(signal.SIGHUP) == signal.SIG_IGN)
''')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'continua True')

    def test_asyncio_add_signal_handler(self):
        result, names = self.ending('''
import asyncio

async def main():
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    loop.add_signal_handler(signal.SIGTERM, stop.set)
    last_work()
    os.kill(os.getpid(), signal.SIGTERM)
    await asyncio.wait_for(stop.wait(), 5)
    print('parou pelo handler do asyncio', flush=True)

asyncio.run(main())
''')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'parou pelo handler do asyncio')
        self.assertIn('last_work', names)

    def test_sys_exit(self):
        result, names = self.ending('''
last_work()
print('pendente', pending(), flush=True)
sys.exit(2)
''')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout.strip(), 'pendente True')
        self.assertIn('last_work', names)

    def test_thread_de_escrita_parada_antes_do_fim_do_interpretador(self):
        # A daemon thread waking while the interpreter shuts down crashed
        # CPython 3.12 (SIGSEGV, stage 8). At exit the thread is stopped and
        # joined, then the queue is flushed.
        result, names = self.ending('''
last_work()
thread = codetac_py.writer.thread
print('antes', thread.is_alive(), pending(), flush=True)
codetac_py.writer.close()
print('depois', thread.is_alive(), len(codetac_py.writer.queue) > 0, flush=True)
''')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.split(), ['antes', 'True', 'True', 'depois', 'False', 'False'])
        self.assertIn('last_work', names)

    def test_eventos_dos_handlers_atexit_da_app_sao_gravados(self):
        # The writer's own atexit handler was registered first: it runs last.
        result, names = self.ending('''
import atexit
atexit.register(last_work)
''')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('last_work', names)

    def test_excecao_nao_apanhada(self):
        result, names = self.ending('''
def crash():
    raise RuntimeError('rebenta')

last_work()
print('pendente', pending(), flush=True)
crash()
''')
        self.assertEqual(result.returncode, 1)
        self.assertIn('RuntimeError: rebenta', result.stderr)
        self.assertIn('last_work', names)
        events = self.events()
        crash = [event for event in events if event.get('function') == 'crash'][0]
        ending = [event for event in events if event['type'] == 'exit' and event['id'] == crash['id']]
        self.assertEqual([event['error'] for event in ending], [True])


class Fork(Sandbox):
    @unittest.skipUnless(hasattr(os, 'fork'), 'sem os.fork')
    def test_filho_escreve_o_seu_ficheiro_sem_repetir_o_do_pai(self):
        result = self.run_script('main.py', PREAMBLE + '''
import warnings
warnings.simplefilter('ignore', DeprecationWarning)

def before_fork():
    return 1

def in_child():
    return 2

before_fork()
pid = os.fork()
if pid == 0:
    in_child()
    sys.exit(0)
os.waitpid(pid, 0)
print(pid)
''')
        self.assertEqual(result.returncode, 0, result.stderr)
        child = int(result.stdout.strip())
        events = self.events()
        by_process = {}
        for event in events:
            by_process.setdefault(event['process'], []).append(event)
        child_events = by_process['%d:0' % child]
        # Regression (stage 3): the child's file also starts with capture-start,
        # which recording.mjs reads from the first line of any file.
        self.assertEqual(child_events[0]['type'], 'capture-start')
        self.assertEqual(child_events[0]['root'], self.project)
        for path in glob.glob(os.path.join(self.home, 'ensaio', '*.jsonl')):
            with open(path, encoding='utf-8') as file:
                self.assertEqual(json.loads(file.readline())['type'], 'capture-start')
        self.assertEqual([event['function'] for event in child_events if event['type'] == 'enter'], ['in_child'])
        self.assertEqual([event['sequence'] for event in child_events], list(range(1, len(child_events) + 1)))
        parent_names = [event.get('function') for events in by_process.values() if events is not child_events
                        for event in events if event['type'] == 'enter']
        self.assertEqual(parent_names.count('before_fork'), 1)
        self.assertNotIn('in_child', parent_names)


if __name__ == '__main__':
    unittest.main()
