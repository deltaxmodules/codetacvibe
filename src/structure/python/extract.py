"""Facts of Python files for the StructureTAC Python reader (phase 11).

Reads, from stdin, {"root": <folder>, "files": [<relative path>, ...]} and
writes to stdout {"python": [major, minor], "files": {<path>: facts}}. Only
the syntax is read (ast); no file of the project is imported or run. The
graph is built on the Node side (src/structure/python/reader.mjs) with the
same rules as the Node reader. Standard library only, Python 3.8 or later.

Facts of one file:
  imports      [{module, level, names: [{name, as}] | null, as, line, scope}]
  definitions  [{qualname, name, kind: function|class|method, line, endLine,
                 async, nested, decorators: [expr], defaults: [expr] (functions),
                 bases: [expr], keywords: {} (classes)}]
  assignments  [{targets: [expr], annotation: expr, value: expr, line, scope}]  (also `with X as x`)
  calls        [{func: expr, args: [expr], kw: {name: expr}, line, endLine, scope}]
  environ      [{name, how, line, scope}]    os.environ['X'], os.getenv('X'), environ.get('X')
  names        [dotted names read anywhere in the file, unique]
  error        {line, message} when the file does not parse
An expression (expr) is a small summary: {"t": "str"|"const"|"name"|"attr"|
"call"|"sub"|"fstr"|"dict"|"list"|"other", ...}, cut at a fixed depth.
The line of a function or class is the line of its `def`/`class` (not of its
first decorator), the same line the Python capture uses in its keys.
"""
import ast
import json
import os
import sys

MAX_BYTES = 2 * 1024 * 1024
MAX_TEXT = 2000
MAX_DEPTH = 5


def dotted(node):
    """a.b.c for a Name or a chain of attributes on a Name, else None."""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return '.'.join(reversed(parts))
    return None


def summary(node, depth=0):
    if node is None:
        return None
    if depth > MAX_DEPTH:
        return {'t': 'other'}
    if isinstance(node, ast.Constant):
        if isinstance(node.value, str):
            return {'t': 'str', 'v': node.value[:MAX_TEXT]}
        if node.value is None or isinstance(node.value, (bool, int, float)):
            return {'t': 'const', 'v': node.value}
        return {'t': 'other'}
    name = dotted(node)
    if name is not None:
        return {'t': 'name', 'v': name}
    if isinstance(node, ast.Attribute):
        return {'t': 'attr', 'of': summary(node.value, depth + 1), 'name': node.attr}
    if isinstance(node, ast.Call):
        return call_summary(node, depth)
    if isinstance(node, ast.Subscript):
        key = node.slice
        if hasattr(ast, 'Index') and isinstance(key, getattr(ast, 'Index')):  # Python 3.8
            key = key.value
        return {'t': 'sub', 'of': summary(node.value, depth + 1), 'key': summary(key, depth + 1)}
    if isinstance(node, ast.JoinedStr):
        text = ''
        for part in node.values:
            if isinstance(part, ast.Constant) and isinstance(part.value, str):
                text += part.value
            else:
                text += '{}'
        found = {'t': 'fstr', 'v': text[:MAX_TEXT]}
        # What the text starts with, when it starts with a value: f"{BASE_URL}/x".
        if node.values and isinstance(node.values[0], ast.FormattedValue):
            found['head'] = summary(node.values[0].value, depth + 1)
        return found
    if isinstance(node, ast.Dict):
        return {'t': 'dict', 'keys': [summary(key, depth + 1) for key in node.keys],
                'values': [summary(value, depth + 1) for value in node.values]}
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return {'t': 'list', 'items': [summary(item, depth + 1) for item in node.elts]}
    if isinstance(node, ast.Await):
        return summary(node.value, depth)
    return {'t': 'other', 'kind': type(node).__name__}


def call_summary(node, depth=0):
    keywords = {}
    for keyword in node.keywords:
        if keyword.arg is not None:
            keywords[keyword.arg] = summary(keyword.value, depth + 1)
    return {'t': 'call', 'func': summary(node.func, depth + 1),
            'args': [summary(arg, depth + 1) for arg in node.args], 'kw': keywords, 'line': node.lineno}


def environ_name(node):
    """The variable of os.environ['X'] (a subscript), or None."""
    if isinstance(node, ast.Subscript):
        base = dotted(node.value)
        key = node.slice
        if hasattr(ast, 'Index') and isinstance(key, getattr(ast, 'Index')):
            key = key.value
        if base in ('os.environ', 'environ') and isinstance(key, ast.Constant) and isinstance(key.value, str):
            return key.value
    return None


ENV_CALLS = {'os.getenv': 'getenv', 'getenv': 'getenv', 'os.environ.get': 'environ.get', 'environ.get': 'environ.get',
             'os.environ.setdefault': 'environ.setdefault'}


class Reader(ast.NodeVisitor):
    def __init__(self):
        self.scope = []   # [(name, kind)] of the enclosing definitions
        self.facts = {'imports': [], 'definitions': [], 'assignments': [], 'calls': [], 'environ': []}
        self.names = set()

    def here(self):
        return '.'.join(name for name, _ in self.scope) or None

    def define(self, node, kind):
        parent = self.scope[-1][1] if self.scope else None
        if kind == 'function' and parent == 'class':
            kind = 'method'
        for decorator in node.decorator_list:
            self.visit(decorator)
        entry = {'qualname': '.'.join([name for name, _ in self.scope] + [node.name]), 'name': node.name, 'kind': kind,
                 'line': node.lineno, 'endLine': getattr(node, 'end_lineno', None) or node.lineno,
                 'async': isinstance(node, ast.AsyncFunctionDef), 'nested': parent in ('function', 'method'),
                 'decorators': [summary(decorator) for decorator in node.decorator_list]}
        if isinstance(node, ast.ClassDef):
            entry['bases'] = [summary(base) for base in node.bases]
            entry['keywords'] = {keyword.arg: summary(keyword.value) for keyword in node.keywords if keyword.arg}
            for item in node.bases + [keyword.value for keyword in node.keywords]:
                self.visit(item)
        else:
            # Defaults are evaluated where the function is defined (Depends(get_db) of FastAPI).
            defaults = node.args.defaults + [default for default in node.args.kw_defaults if default is not None]
            entry['defaults'] = [summary(default) for default in defaults]
            for item in defaults:
                self.visit(item)
        self.facts['definitions'].append(entry)
        self.scope.append((node.name, 'class' if kind == 'class' else 'function'))
        for item in node.body:
            self.visit(item)
        self.scope.pop()

    def visit_FunctionDef(self, node):
        self.define(node, 'function')

    def visit_AsyncFunctionDef(self, node):
        self.define(node, 'function')

    def visit_ClassDef(self, node):
        self.define(node, 'class')

    def visit_Import(self, node):
        for alias in node.names:
            self.facts['imports'].append({'module': alias.name, 'level': 0, 'names': None, 'as': alias.asname,
                                          'line': node.lineno, 'scope': self.here()})

    def visit_ImportFrom(self, node):
        self.facts['imports'].append({'module': node.module or '', 'level': node.level or 0,
                                      'names': [{'name': alias.name, 'as': alias.asname} for alias in node.names],
                                      'as': None, 'line': node.lineno, 'scope': self.here()})

    def assignment(self, node, targets, annotation, value):
        self.facts['assignments'].append({'targets': [summary(target) for target in targets], 'annotation': summary(annotation),
                                          'value': summary(value), 'line': node.lineno, 'scope': self.here()})
        self.generic_visit(node)

    def visit_Assign(self, node):
        self.assignment(node, node.targets, None, node.value)

    def visit_AnnAssign(self, node):
        self.assignment(node, [node.target], node.annotation, node.value)

    def visit_With(self, node):
        # `with X() as x` binds x like an assignment (async with httpx.AsyncClient() as client).
        for item in node.items:
            if item.optional_vars is not None:
                self.facts['assignments'].append({'targets': [summary(item.optional_vars)], 'annotation': None,
                                                  'value': summary(item.context_expr), 'line': node.lineno, 'scope': self.here()})
        self.generic_visit(node)

    visit_AsyncWith = visit_With

    def visit_Call(self, node):
        entry = call_summary(node)
        entry.pop('t')
        entry['endLine'] = getattr(node, 'end_lineno', None) or node.lineno
        entry['scope'] = self.here()
        self.facts['calls'].append(entry)
        name = dotted(node.func)
        if name in ENV_CALLS and node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
            self.facts['environ'].append({'name': node.args[0].value, 'how': ENV_CALLS[name], 'line': node.lineno, 'scope': self.here()})
        self.generic_visit(node)

    def visit_Subscript(self, node):
        name = environ_name(node)
        if name is not None:
            self.facts['environ'].append({'name': name, 'how': 'environ[]', 'line': node.lineno, 'scope': self.here()})
        self.generic_visit(node)

    def visit_Attribute(self, node):
        name = dotted(node)
        if name is not None:
            self.names.add(name)
            return
        self.generic_visit(node)

    def visit_Name(self, node):
        if isinstance(node.ctx, ast.Load):
            self.names.add(node.id)


def read_file(root, path):
    full = os.path.join(root, path)
    try:
        if os.path.getsize(full) > MAX_BYTES:
            return {'error': {'line': 1, 'message': 'file too large to read'}}
        with open(full, 'rb') as handle:
            source = handle.read()
        tree = ast.parse(source, filename=path)
    except SyntaxError as error:
        return {'error': {'line': error.lineno or 1, 'message': (error.msg or 'syntax error')[:200]}}
    except (OSError, ValueError, RecursionError, MemoryError) as error:
        return {'error': {'line': 1, 'message': type(error).__name__}}
    reader = Reader()
    try:
        reader.visit(tree)
    except RecursionError:
        return {'error': {'line': 1, 'message': 'nested too deeply to read'}}
    facts = reader.facts
    facts['names'] = sorted(reader.names)
    return facts


def main():
    request = json.loads(sys.stdin.read())
    root = request['root']
    files = {path: read_file(root, path) for path in request['files']}
    json.dump({'python': list(sys.version_info[:2]), 'files': files}, sys.stdout, separators=(',', ':'))


if __name__ == '__main__':
    main()
