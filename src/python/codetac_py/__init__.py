"""CodeTAC capture for Python apps (FastAPI, Flask).

Loaded by sitecustomize.py only when CODETAC_RUN is set. It writes the same
JSONL events as the Node runtime (src/runtime.mjs), so the store, the panel
and the bar need no Python branches.

This file, writer.py and redact.py must stay importable on old Pythons
(3.8+): below the minimum the capture falls back to the minimal mode instead
of breaking the app. capture.py needs 3.12 (sys.monitoring).
"""
import os
import re
import sys

MINIMUM = (3, 12)

level = None
root = None
reason = None
writer = None
monitor = None  # capture.Capture, when the project's functions are followed
# 'supervisor' in a process that only watches files or manages workers (the
# reloader of werkzeug, uvicorn --reload, fastapi dev): it serves nothing.
role = 'app'


def start():
    global level, reason, writer, monitor, root
    run = os.environ.get('CODETAC_RUN', '')
    if not re.match(r'^[a-zA-Z0-9_-]{1,80}$', run):
        sys.stderr.write('codeTAC: CODETAC_RUN: use only letters, digits, _ or - (at most 80). Capture disabled.\n')
        return
    from .writer import Writer, data_directory, install_signals
    root = os.path.realpath(os.environ.get('CODETAC_ROOT') or os.getcwd())
    writer = Writer(os.path.join(data_directory(), run))

    if os.environ.get('CODETAC_LEVEL') == 'minimo':
        level, reason = 'minimo', os.environ.get('CODETAC_MINIMO_MOTIVO') or 'requested at startup'
    elif sys.version_info < MINIMUM:
        level = 'minimo'
        reason = 'Python %d.%d cannot follow the functions (%d.%d or newer is needed)' % (
            sys.version_info[:2] + MINIMUM)
    else:
        from .capture import Capture, NoToolId
        try:
            monitor = Capture(writer, root)
            level, reason = 'normal', None
        except NoToolId as error:
            level, reason = 'minimo', str(error)

    event = {'type': 'capture-start', 'root': root, 'python': '%d.%d.%d' % sys.version_info[:3], 'level': level}
    if reason:
        event['reason'] = reason
    writer.start(event)
    install_signals(writer.flush)
    if monitor is not None:
        monitor.start()
    from .servers import install_hooks
    install_hooks()
    from .boundaries import install as install_boundaries
    install_boundaries(root, data_directory())
    from .frameworks import install as install_frameworks
    install_frameworks()
    if hasattr(os, 'register_at_fork'):
        os.register_at_fork(after_in_child=_after_fork)


def mark_supervisor(server):
    """This process supervises the one that serves: it stops following functions."""
    global role
    if role == 'supervisor':
        return
    role = 'supervisor'
    if monitor is not None:
        monitor.pause()
    # Only when the process already left a file (it imported the app, as the
    # reloader of flask run --debug does): it says why nothing else follows.
    if writer.active:
        writer.emit({'type': 'process', 'role': 'supervisor', 'server': server})


def _after_fork():
    """A worker forked by a supervisor (gunicorn) serves: it follows functions again."""
    global role
    if role == 'supervisor':
        role = 'app'
        if monitor is not None:
            monitor.resume()
