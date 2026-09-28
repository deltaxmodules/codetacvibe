"""Which files are the project's own code: used by the capture (functions to
follow) and by the file boundaries (who is writing).

Keep it importable on old Pythons (3.8+): the minimal mode records file
writes too.
"""
import os

CAPTOR = os.path.realpath(os.path.dirname(os.path.abspath(__file__)))
# Folders that never hold the project's own code, wherever they are.
EXCLUDED = {'site-packages', 'dist-packages', '__pycache__', 'node_modules', 'venv'}


def project_path(filename, root, python=True):
    """The real path of a .py file of the project under root, or None. With python=False,
    any file of the project (Jinja templates, jinja_map.py)."""
    # <frozen ...>, <string> and other generated code are not the project's
    # .py files; templates are recognised by their code (jinja_map.py).
    if not filename or filename.startswith('<') or (python and not filename.endswith('.py')):
        return None
    path = os.path.realpath(filename)
    if not os.path.isfile(path) or path.startswith(CAPTOR + os.sep):
        return None
    relative = os.path.relpath(path, root)
    if relative == os.pardir or relative.startswith(os.pardir + os.sep) or os.path.isabs(relative):
        return None
    folder = root
    for part in relative.split(os.sep)[:-1]:
        # Hidden folders (.venv, .git, .tox...), dependencies, and any
        # virtual environment, whatever its name, inside the project.
        if part.startswith('.') or part in EXCLUDED:
            return None
        folder = os.path.join(folder, part)
        if os.path.exists(os.path.join(folder, 'pyvenv.cfg')):
            return None
    return path


class ProjectFiles(object):
    """project_path with a cache per file name. With python=False, the files of the
    project that are not .py (templates)."""

    def __init__(self, root, python=True):
        self.root = os.path.realpath(root)
        self.python = python
        self.files = {}

    def __call__(self, filename):
        known = self.files.get(filename, False)
        if known is not False:
            return known
        path = None
        try:
            path = project_path(filename, self.root, self.python)
            if path is not None and not self.python and path.endswith('.py'):
                path = None
        except (OSError, ValueError):
            pass
        self.files[filename] = path
        return path
