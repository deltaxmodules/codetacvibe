"""Stage 6: database boundaries (spec 3.7), with the fields of src/boundaries.mjs."""
import json
import os
import sys
import unittest

from helpers import SRC, Sandbox

sys.path.insert(0, SRC)
from codetac_py.boundaries import describe_sql  # noqa: E402

VECTORS = os.path.join(os.path.dirname(__file__), '..', 'vetores-sql.json')

SQLITE_APP = '''
import sqlite3, json
from codetac_py import capture

class Rows(sqlite3.Connection):
    """The app's own factory."""

def prepare(db):
    db.executescript("create table items (id integer primary key, owner text, title text);")

def insert(db):
    db.execute("insert into items (owner, title) values (?, ?)", ("ana", "valor-secreto-do-parametro"))
    db.executemany("insert into items (owner, title) values (?, ?)", [("ana", "a"), ("rui", "b")])

def rename(db, item):
    cursor = db.cursor()
    cursor.execute("update items set title = 'titulo-literal-secreto' where id = ?", (item,))
    return cursor.rowcount

def listing(db):
    return db.execute("select id, title from items where owner = ?", ("ana",)).fetchall()

def broken(db):
    try:
        db.execute("select * from nao_existe")
    except sqlite3.OperationalError:
        return 'erro tratado'

def handler():
    db = sqlite3.connect(":memory:", factory=Rows)
    db.row_factory = sqlite3.Row
    prepare(db)
    insert(db)
    print(rename(db, 1), rename(db, 999), len(listing(db)), broken(db), isinstance(db, Rows))
    db.commit()

scope = capture.request_scope('"py:r1"')
handler()
capture.current.reset(scope)
'''


class DescribeSql(unittest.TestCase):
    def test_vetores_partilhados_com_o_node(self):
        with open(VECTORS, encoding='utf-8') as file:
            cases = json.load(file)['casos']
        for case in cases:
            with self.subTest(entrada=(case['entrada'] or '')[:60]):
                self.assertEqual(describe_sql(case['entrada']), case['saida'])


class Sqlite(Sandbox):
    def test_sqlite3_leituras_escritas_e_erros(self):
        result = self.run_script('main.py', SQLITE_APP)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), '1 0 2 erro tratado True')
        events = self.events()
        calls = self.calls(events)
        starts = [event for event in events if event['type'] == 'boundary']
        ends = {event['id']: event for event in events if event['type'] == 'boundary-end'}
        summary = [(event['operation'], event['tables'], {k: v for k, v in ends[event['id']].items() if k in ('rows', 'affectedRows', 'error')})
                   for event in starts]
        self.assertEqual(summary, [
            ('CREATE', ['items'], {'error': False}),
            ('INSERT', ['items'], {'affectedRows': 1, 'error': False}),
            ('INSERT', ['items'], {'affectedRows': 2, 'error': False}),  # executemany: one boundary
            ('UPDATE', ['items'], {'affectedRows': 1, 'error': False}),
            ('UPDATE', ['items'], {'affectedRows': 0, 'error': False}),  # a write that changes no rows
            ('SELECT', ['items'], {'error': False}),
            ('SELECT', ['nao_existe'], {'error': True}),
        ])
        # Each one inside the function that makes it, in the request.
        parents = [calls[name][index]['id'] for name, index in
                   (('prepare', 0), ('insert', 0), ('insert', 0), ('rename', 0), ('rename', 1), ('listing', 0), ('broken', 0))]
        self.assertEqual([event['parentId'] for event in starts], parents)
        self.assertEqual({event['requestId'] for event in starts}, {'py:r1'})
        self.assertEqual({event['library'] for event in starts}, {'sqlite3'})
        self.assertEqual({event['kind'] for event in starts}, {'base-de-dados'})
        # No values: parameters are never read, string literals are replaced.
        raw = self.raw()
        for value in ('valor-secreto-do-parametro', 'titulo-literal-secreto', '"ana"', '"rui"'):
            self.assertNotIn(value, raw)
        self.assertIn("update items set title = '?' where id = ?", raw)

    def test_sqlite3_importado_antes_do_captor_e_aiosqlite_ausente(self):
        # sitecustomize runs before the app, but a module may import sqlite3 early.
        result = self.run_script('main.py', '''
import sqlite3
from codetac_py import capture

def work():
    sqlite3.connect(":memory:").execute("select 1").fetchall()

scope = capture.request_scope('"py:r1"')
work()
''')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([event['operation'] for event in self.events() if event['type'] == 'boundary'], ['SELECT'])


if __name__ == '__main__':
    unittest.main()
