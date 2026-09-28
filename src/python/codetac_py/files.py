"""File boundaries (stage 7), as installFiles in src/boundaries.mjs: only
operations made directly by the project's code during a request.

  boundary  {kind: 'ficheiros', provider: 'file system', library: 'builtins' | 'os',
             function, operation, path}

- open() in a mode that writes (w, a, x, +): 'escrita'. pathlib's
  write_text, write_bytes and open go through io.open;
- os.remove/unlink/rmdir ('remoção'), os.rename/replace ('mudança de
  nome'), os.mkdir ('criação de pasta'; os.makedirs and Path.mkdir use it).

The first caller frame outside the captor and the standard library decides:
a library (site-packages, a virtual environment) is not the project. Reads
are not recorded (M66). The captor's own files and CodeTAC's data folder are
never boundaries; the captor writes with os.open/os.write, which are not
observed.

Keep it importable on old Pythons (3.8+): the minimal mode records boundaries.
"""
import builtins
import functools
import io
import os
import sys
import sysconfig

from .boundaries import _inside, start_boundary
from .context import NULL, current
from .project import CAPTOR, ProjectFiles
from .servers import safe_path

WRITES = set('wax+')
OPERATIONS = {'remove': 'remoção', 'unlink': 'remoção', 'rmdir': 'remoção', 'rename': 'mudança de nome',
              'replace': 'mudança de nome', 'mkdir': 'criação de pasta'}
DEPTH = 12
# The captor's code, by its real path and by the path it was imported from.
CODE = tuple(set(folder + os.sep for folder in (CAPTOR, os.path.dirname(os.path.abspath(__file__)))))


def _standard_library():
    paths = sysconfig.get_paths()
    folders = set()
    for key in ('stdlib', 'platstdlib'):
        if paths.get(key):
            folders.add(os.path.realpath(paths[key]) + os.sep)
            folders.add(os.path.abspath(paths[key]) + os.sep)
    return tuple(folders)


class Files(object):
    def __init__(self, root, data):
        self.root = os.path.realpath(root)
        self.project_file = ProjectFiles(self.root)
        self.own = tuple(os.path.realpath(folder) + os.sep for folder in (CAPTOR, data))
        self.stdlib = _standard_library()

    def caller_is_project(self):
        frame = sys._getframe(3)
        for _ in range(DEPTH):
            if frame is None:
                return False
            filename = frame.f_code.co_filename
            if 'site-packages' in filename or 'dist-packages' in filename:
                return False
            if filename.startswith(CODE) or filename.startswith('<frozen') or filename.startswith(self.stdlib):
                frame = frame.f_back
                continue
            return self.project_file(filename) is not None
        return False

    def describe(self, target):
        if isinstance(target, int):
            return '(descriptor)'
        path = os.fsdecode(os.fspath(target))
        real = os.path.realpath(path)
        if (real + os.sep).startswith(self.own):
            return None
        within = os.path.relpath(real, self.root)
        if within != os.curdir and not within.startswith(os.pardir) and not os.path.isabs(within):
            path = within
        return safe_path(path)

    def start(self, function, operation, target):
        """end(extra), or None when this operation is not a boundary."""
        if current.get()[1] == NULL or _inside.get() or not self.caller_is_project():
            return None
        try:
            path = self.describe(target)
        except (TypeError, ValueError, OSError):
            return None
        if path is None:
            return None
        return start_boundary({'kind': 'ficheiros', 'provider': 'file system',
                               'library': 'builtins' if function == 'open' else 'os',
                               'function': function, 'operation': operation, 'path': path})


def _observe(files, function, operation, original):
    @functools.wraps(original)
    def wrapper(target, *args, **kwargs):
        end = files.start(function, operation, target)
        if end is None:
            return original(target, *args, **kwargs)
        try:
            result = original(target, *args, **kwargs)
        except BaseException:
            end({'error': True})
            raise
        end()
        return result
    wrapper.__codetac__ = True
    return wrapper


def install(root, data):
    if getattr(builtins.open, '__codetac__', False):
        return
    files = Files(root, data)
    original_open = builtins.open
    writing = _observe(files, 'open', 'escrita', original_open)

    @functools.wraps(original_open)
    def codetac_open(file, mode='r', *args, **kwargs):
        if isinstance(mode, str) and WRITES.intersection(mode):
            return writing(file, mode, *args, **kwargs)
        return original_open(file, mode, *args, **kwargs)

    codetac_open.__codetac__ = True
    builtins.open = codetac_open
    if io.open is original_open:
        io.open = codetac_open
    for name, operation in OPERATIONS.items():
        original = getattr(os, name, None)
        if original is not None and not getattr(original, '__codetac__', False):
            setattr(os, name, _observe(files, name, operation, original))
