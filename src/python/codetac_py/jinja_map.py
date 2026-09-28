"""Lines of Jinja templates, the Python equivalent of source maps.

The code Jinja compiles from a template has the template's path as its file
name, but its lines are those of the generated Python. The module of each
template keeps `debug_info`, pairs "template line=generated line", the table
Template.get_corresponding_lineno reads. The functions of the template (the
body `root`, each `block_*`, macros) are shown at their line of the .html.

When the table cannot be read, or gives a line the file does not have, the
template is a single opaque step, with a diagnostic: never a wrong line.
"""
import os

from .project import project_path


def is_template(globals_):
    """Whether a frame's globals are those of a compiled Jinja template."""
    return '__jinja_template__' in globals_ or ('debug_info' in globals_ and 'environment' in globals_ and 'blocks' in globals_)


def template_file(code, globals_, root):
    """The real path of the template, when it is a file of the project."""
    filename = globals_.get('__file__') or code.co_filename
    if not isinstance(filename, str) or filename.startswith('<'):
        return None
    try:
        return project_path(os.path.abspath(filename), root, python=False)
    except (OSError, ValueError):
        return None


def read_table(text):
    """"1=12&2=17" -> [(1, 12), (2, 17)]; None when it is not a table."""
    if not isinstance(text, str):
        return None
    pairs = []
    if text:
        for item in text.split('&'):
            template_line, _, code_line = item.partition('=')
            if not template_line.isdigit() or not code_line.isdigit():
                return None
            pairs.append((int(template_line), int(code_line)))
    return pairs


def label(code, template):
    if code.co_name == 'root':
        return 'template %s' % template
    if code.co_name.startswith('block_'):
        return 'block %s (%s)' % (code.co_name[len('block_'):], template)
    return '%s (%s)' % (code.co_name, template)


def place(code, table, line_count):
    """(line, endLine) in the template for a function of its compiled code, or None."""
    first = code.co_firstlineno
    # Only the lines this code runs itself: a macro defined inside the body of
    # the template has lines of its own.
    own = set(line for _, _, line in code.co_lines() if line is not None)
    inside = [template_line for template_line, code_line in table if code_line in own]
    at_def = [template_line for template_line, code_line in table if code_line == first]
    if at_def:
        line = at_def[0]
    elif code.co_name == 'root':
        # The body of the template starts at its first line; Jinja records no line for it.
        line = 1
    elif inside:
        line = min(inside)
    else:
        return None
    end = max(inside + [line])
    if not 1 <= line <= end <= line_count:
        return None
    return line, end


def _up_to_date(globals_):
    template = globals_.get('__jinja_template__')
    try:
        return bool(getattr(template, 'is_up_to_date', True))
    except Exception:
        return False


class Templates(object):
    """What the capture needs to know about each template file, read once."""

    def __init__(self, root):
        self.root = root
        self.counts = {}   # real path -> number of lines, or None
        self.failed = set()  # templates announced as opaque

    def line_count(self, path):
        if path not in self.counts:
            try:
                with open(path, 'rb') as file:
                    data = file.read()
                self.counts[path] = data.count(b'\n') + (0 if data.endswith(b'\n') or not data else 1)
            except OSError:
                self.counts[path] = None
        return self.counts[path]

    def describe(self, code, globals_):
        """(metadata of the function, limitation event or None), or None when the code is not
        a function of a project template."""
        path = template_file(code, globals_, self.root)
        if path is None:
            return None
        name = globals_.get('name') if isinstance(globals_.get('name'), str) else os.path.basename(path)
        table = read_table(globals_.get('debug_info'))
        count = self.line_count(path)
        # A table with a line the file does not have is not this file's (the
        # template changed on disk, or it is not Jinja's): nothing of it is used.
        # Nor when Jinja itself says the file changed since it was compiled.
        if table is not None and count and all(1 <= line <= count for line, _ in table) and _up_to_date(globals_):
            found = place(code, table, count)
        else:
            found = None
        if found is not None:
            return {'function': label(code, name), 'file': path, 'line': found[0], 'endLine': found[1], 'column': None,
                    'mapped': True, 'async': bool(code.co_flags & 0x0380)}, None
        # Opaque: the body of the template is one step without lines; its other
        # functions are not shown (they would need lines to be told apart).
        if code.co_name != 'root':
            return None
        limitation = None
        if path not in self.failed:
            self.failed.add(path)
            limitation = {'type': 'limitation', 'reason': 'template-lines-unmapped', 'file': path}
        return {'function': 'template %s' % name, 'file': path, 'line': None, 'endLine': None, 'column': None,
                'mapped': False, 'async': False, 'opaque': True}, limitation
