"""Entry point. Python imports it at startup because the codetac command puts
this folder first in PYTHONPATH.

1. This folder leaves sys.path at once, so the other files here (capture.py,
   page.py...) never shadow the app's own modules of the same name.
2. Without CODETAC_RUN (for example any subprocess that inherits PYTHONPATH)
   the capture does nothing.
3. The sitecustomize this file shadows is looked up further along sys.path and
   run, so environments that rely on it keep working. usercustomize is not
   shadowed (there is none here): site.py imports it as usual.

Keep it importable on old Pythons (3.8+).
"""
import importlib.util
import os
import sys
from importlib.machinery import PathFinder

HERE = os.path.realpath(os.path.dirname(os.path.abspath(__file__)))


def _is_here(entry):
    try:
        return os.path.realpath(entry or os.curdir) == HERE
    except (TypeError, ValueError):
        return False


def _leave_sys_path():
    sys.path[:] = [entry for entry in sys.path if not _is_here(entry)]
    for entry in list(sys.path_importer_cache):
        if _is_here(entry):
            del sys.path_importer_cache[entry]


def _start_capture():
    spec = importlib.util.spec_from_file_location(
        'codetac_py', os.path.join(HERE, '__init__.py'), submodule_search_locations=[HERE])
    package = importlib.util.module_from_spec(spec)
    sys.modules['codetac_py'] = package
    try:
        spec.loader.exec_module(package)
        package.start()
    except Exception as error:  # the app must start even if the capture cannot
        sys.modules.pop('codetac_py', None)
        sys.stderr.write('codeTAC: captura desligada (%s: %s)\n' % (type(error).__name__, error))


def _chain_original():
    spec = PathFinder.find_spec('sitecustomize', sys.path)
    if spec is None or spec.loader is None:
        return
    original = importlib.util.module_from_spec(spec)
    sys.modules['sitecustomize'] = original
    # Errors propagate to site.py, which reports them as it would have.
    spec.loader.exec_module(original)


_leave_sys_path()
if os.environ.get('CODETAC_RUN'):
    _start_capture()
_chain_original()
