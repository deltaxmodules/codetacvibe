"""Stage 7: file boundaries (spec 3.7): writes made by the project's code
during a request; never the captor's own, nor those of a library."""
import os
import unittest

from helpers import Sandbox, write

APP = '''
import os, pathlib, sys
from codetac_py import capture
import helper_library

HOME = os.environ['CODETAC_HOME']

def export(folder):
    with open(os.path.join(folder, 'relatorio.csv'), 'w') as file:
        file.write('a,b\\n')
    with open(os.path.join(folder, 'relatorio.csv'), 'a') as file:
        file.write('c,d\\n')
    pathlib.Path(folder, 'notas.txt').write_text('texto')
    with open(os.path.join(folder, 'relatorio.csv')) as file:  # a read: not a boundary
        file.read()

def tidy(folder):
    os.makedirs(os.path.join(folder, 'arquivo', '2026'))
    os.rename(os.path.join(folder, 'notas.txt'), os.path.join(folder, 'arquivo', 'notas.txt'))
    os.remove(os.path.join(folder, 'arquivo', 'notas.txt'))
    try:
        os.remove(os.path.join(folder, 'nao-existe.txt'))
    except FileNotFoundError:
        pass

def into_codetac_folder():
    with open(os.path.join(HOME, 'escrita-da-app.txt'), 'w') as file:
        file.write('x')

def handler(folder):
    export(folder)
    tidy(folder)
    helper_library.save(os.path.join(folder, 'da-biblioteca.txt'))
    into_codetac_folder()

folder = os.path.join(os.getcwd(), 'saida')
os.mkdir(folder)  # outside a request: not a boundary
scope = capture.request_scope('"py:r1"')
handler(folder)
capture.current.reset(scope)
print(sorted(os.listdir(folder)))
'''


class Files(Sandbox):
    def test_escritas_do_projeto_num_pedido(self):
        write(self.libs, 'helper_library.py', '''
            def save(path):
                with open(path, 'w') as file:
                    file.write('biblioteca')
            ''')
        result = self.run_script('main.py', APP)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "['arquivo', 'da-biblioteca.txt', 'relatorio.csv']")
        events = self.events()
        by = {event['id']: event['function'] for event in events if event['type'] == 'enter'}
        starts = [event for event in events if event['type'] == 'boundary']
        ends = {event['id']: event for event in events if event['type'] == 'boundary-end'}
        summary = [(by[event['parentId']], event['function'], event['operation'], event['path'], ends[event['id']]['error'])
                   for event in starts]
        self.assertEqual(summary, [
            ('export', 'open', 'escrita', 'saida/relatorio.csv', False),
            ('export', 'open', 'escrita', 'saida/relatorio.csv', False),
            ('export', 'open', 'escrita', 'saida/notas.txt', False),  # pathlib
            ('tidy', 'mkdir', 'criação de pasta', 'saida/arquivo', False),  # os.makedirs, one per folder
            ('tidy', 'mkdir', 'criação de pasta', 'saida/arquivo/2026', False),
            ('tidy', 'rename', 'mudança de nome', 'saida/notas.txt', False),
            ('tidy', 'remove', 'remoção', 'saida/arquivo/notas.txt', False),
            ('tidy', 'remove', 'remoção', 'saida/nao-existe.txt', True),
        ])
        self.assertEqual({(event['kind'], event['provider'], event['requestId']) for event in starts},
                         {('ficheiros', 'file system', 'py:r1')})
        # Never the captor's recording nor CodeTAC's data folder, never a library.
        raw = self.raw()
        for value in ('escrita-da-app', '.jsonl', 'da-biblioteca', self.home):
            self.assertNotIn(value, raw)
        self.assertTrue(os.path.exists(os.path.join(self.home, 'escrita-da-app.txt')))

    def test_leituras_e_modos_passam_sem_alteracao(self):
        result = self.run_script('main.py', '''
import builtins, io, os
from codetac_py import capture
print(builtins.open is io.open, open.__name__)
scope = capture.request_scope('"py:r1"')
with open('main.py', mode='rb') as file:
    first = file.read(6)
fd = os.open('bruto.bin', os.O_WRONLY | os.O_CREAT)
with open(fd, 'wb') as file:
    file.write(b'1')
print(first)
''')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.split(), ['True', 'open', "b'\\nimpor'"])
        self.assertEqual([(event['path'], event['function']) for event in self.events() if event['type'] == 'boundary'],
                         [('(descriptor)', 'open')])


if __name__ == '__main__':
    unittest.main()
