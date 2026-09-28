"""Shared helpers: a sandbox with a project, libraries and a data folder, and
a way to run Python in it with the captor loaded as the codetac command does."""
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest

SRC = os.path.realpath(os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'python'))
CAPTOR = os.path.join(SRC, 'codetac_py')


def write(folder, name, text):
    path = os.path.join(folder, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as file:
        file.write(textwrap.dedent(text))
    return path


def listing(folder):
    return sorted(os.path.relpath(os.path.join(base, name), folder)
                  for base, dirs, files in os.walk(folder) for name in dirs + files)


def line_of(path, text):
    with open(path, encoding='utf-8') as file:
        for number, line in enumerate(file, 1):
            if text in line:
                return number
    raise AssertionError('%r não está em %s' % (text, path))


class Sandbox(unittest.TestCase):
    run_name = 'ensaio'

    def setUp(self):
        # Short names: long opaque path segments are redacted like tokens (M30).
        self.folder = os.path.realpath(tempfile.mkdtemp(prefix='ctpy'))
        self.addCleanup(shutil.rmtree, self.folder, True)
        self.project = os.path.join(self.folder, 'project')
        self.libs = os.path.join(self.folder, 'libs')
        self.home = os.path.join(self.folder, 'home')
        for folder in (self.project, self.libs, self.home):
            os.makedirs(folder)

    def environment(self, run=None, extra=None):
        env = {key: value for key, value in os.environ.items()
               if not key.startswith('CODETAC_') and key not in ('PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP')}
        env.update(PYTHONPATH=os.pathsep.join([CAPTOR, self.libs]), CODETAC_HOME=self.home, CODETAC_ROOT=self.project)
        if run:
            env['CODETAC_RUN'] = run
        env.update(extra or {})
        return env

    def run_python(self, code, run=None, python=None, extra=None, args=None):
        command = [python or sys.executable] + (args if args is not None else ['-c', code])
        return subprocess.run(command, cwd=self.project, env=self.environment(run, extra),
                              capture_output=True, text=True, timeout=60)

    def run_script(self, name, source, run='ensaio', extra=None):
        """Writes a script in the project and runs it with the capture."""
        write(self.project, name, source)
        return self.run_python(None, run, extra=extra, args=[name])

    def events(self, run='ensaio'):
        found = []
        for path in sorted(glob.glob(os.path.join(self.home, run, '*.jsonl'))):
            with open(path, encoding='utf-8') as file:
                found.extend(json.loads(line) for line in file if line.strip())
        return found

    def raw(self, run='ensaio'):
        text = ''
        for path in sorted(glob.glob(os.path.join(self.home, run, '*.jsonl'))):
            with open(path, encoding='utf-8') as file:
                text += file.read()
        return text

    def calls(self, events):
        """Function name -> list of enter events."""
        found = {}
        for event in events:
            if event['type'] == 'enter':
                found.setdefault(event['function'], []).append(event)
        return found
