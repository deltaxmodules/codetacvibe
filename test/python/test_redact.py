"""Stage 2: the redaction gives the same output as src/redact.mjs (shared vectors)."""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'python'))
from codetac_py.redact import create_redactor, is_sensitive_name  # noqa: E402

VECTORS = os.path.join(os.path.dirname(__file__), '..', 'vetores-redacao.json')


class Redaction(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(VECTORS, encoding='utf-8') as file:
            cls.vectors = json.load(file)

    def test_vetores_partilhados_com_o_node(self):
        redact = create_redactor(self.vectors['env'])
        for case in self.vectors['casos']:
            with self.subTest(entrada=case['entrada']):
                self.assertEqual(redact(case['entrada']), case['saida'])

    def test_truncagem_em_bytes_utf8(self):
        redact = create_redactor(self.vectors['env'], self.vectors['maxBytes'])
        for case in self.vectors['casosCurtos']:
            with self.subTest(entrada=case['entrada']):
                self.assertEqual(redact(case['entrada']), case['saida'])

    def test_nomes_sensiveis(self):
        for case in self.vectors['nomes']:
            with self.subTest(nome=case['nome']):
                self.assertEqual(is_sensitive_name(case['nome']), case['sensivel'])


if __name__ == '__main__':
    unittest.main()
