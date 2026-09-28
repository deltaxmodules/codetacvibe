"""What the codetac command needs to know about a project's Python (Stage 12):
its version, the servers and frameworks it can import, and the declared
dependencies that are not installed. Run with the project's interpreter:

    <python> probe.py <project folder>

Prints one JSON object. Imports nothing of the project: modules are looked up
with importlib.util.find_spec and distributions with importlib.metadata.
Keep it runnable on old Pythons (3.8+): below the minimum the command still
explains the minimal mode.
"""
import json
import os
import re
import sys

MODULES = ['fastapi', 'fastapi_cli', 'uvicorn', 'flask', 'gunicorn', 'hypercorn', 'granian', 'waitress', 'starlette']
NAME = re.compile(r'^\s*([A-Za-z0-9][A-Za-z0-9._-]*)')


def normalise(name):
    return re.sub(r'[-_.]+', '-', name).lower()


def pyproject_dependencies(folder):
    """The [project] dependencies of pyproject.toml, as written (tomllib: 3.11+)."""
    try:
        import tomllib
        with open(os.path.join(folder, 'pyproject.toml'), 'rb') as file:
            project = tomllib.load(file).get('project') or {}
        return [str(item) for item in project.get('dependencies') or []]
    except Exception:
        return []


def requirement_names(folder):
    """Names from requirements*.txt and pyproject.toml ([project] dependencies)."""
    names = []
    for file in sorted(os.listdir(folder)):
        if not re.match(r'^requirements.*\.txt$', file) or re.search(r'(dev|test|lint|doc)', file):
            continue
        try:
            lines = open(os.path.join(folder, file), encoding='utf-8').read().splitlines()
        except (OSError, UnicodeDecodeError):
            continue
        for line in lines:
            line = line.split('#', 1)[0].strip()
            # Options (-r, -e, --index-url) and URLs are not names.
            if not line or line.startswith('-') or '://' in line:
                continue
            match = NAME.match(line)
            if match:
                names.append(match.group(1))
    for item in pyproject_dependencies(folder):
        match = NAME.match(item)
        if match:
            names.append(match.group(1))
    return names


def main():
    folder = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
    import importlib.util
    found = []
    for module in MODULES:
        try:
            if importlib.util.find_spec(module) is not None:
                found.append(module)
        except Exception:
            pass
    # `python -m fastapi dev` needs fastapi/__main__.py (FastAPI 0.111+), not only fastapi_cli.
    if 'fastapi' in found:
        try:
            spec = importlib.util.find_spec('fastapi')
            locations = list(spec.submodule_search_locations or [])
            if any(os.path.exists(os.path.join(location, '__main__.py')) for location in locations):
                found.append('fastapi.__main__')
        except Exception:
            pass
    missing = []
    try:
        from importlib import metadata
        installed = set(normalise(dist.metadata['Name'] or '') for dist in metadata.distributions())
        for name in requirement_names(folder):
            if normalise(name) not in installed and name not in missing:
                missing.append(name)
    except Exception:
        pass
    print(json.dumps({
        'version': '%d.%d.%d' % sys.version_info[:3],
        'executable': sys.executable,
        'virtual': sys.prefix != getattr(sys, 'base_prefix', sys.prefix),
        'modules': found,
        'missing': missing,
        'pyproject': pyproject_dependencies(folder),
    }))


main()
