// Why a part of the application stopped while starting, in one line, and
// whether the error is the application's own (0.3.1). Read from the
// Python tracebacks the part prints.

// One line of a part's output: a traceback starts, a frame, or the exception.
// Only the last traceback is kept (a chained one replaces the first).
// Two formats: Python's own, and Rich's boxed one (fastapi dev, typer), where
// a frame is "│ /path/file.py:57 in name │" and a long path starts on the
// line before.
export function readTraceback(state, line) {
  if (/^(\s*|╭─+ )Traceback \(most recent call last\)/.test(line)) {
    state.traceback = { at: Date.now(), frames: [], error: null, pending: '' };
    return;
  }
  const trace = state.traceback;
  if (!trace || trace.error) return;
  const frame = line.match(/^\s*File "([^"]+)", line (\d+)/);
  const boxed = line.match(/^│ (.*?)\s*│$/)?.[1];
  if (frame) trace.frames.push({ file: frame[1], line: Number(frame[2]) });
  else if (boxed !== undefined) {
    const place = boxed.match(/^(.+):(\d+) in \S+$/);
    if (place && (place[1].startsWith('/') || trace.pending)) trace.frames.push({ file: trace.pending + place[1], line: Number(place[2]) });
    trace.pending = !place && boxed.startsWith('/') ? boxed : '';
  }
  // The exception: an unindented "Name: message" (or a bare name) after the frames.
  else if (trace.frames.length && /^[A-Za-z_][\w.]*(: |$)/.test(line)) trace.error = line.trim();
}

const LIBRARIES = /\/(\.?venv|site-packages|dist-packages)\//;
const CAPTOR = /\/codetac_py\//;

// The application's own error: the deepest frame of the project's code comes
// after the deepest frame of CodeTAC's captor. The captor does not rewrite
// Python code, so running without it (minimal mode) would fail the same way.
// Returns the project frame, relative to the folder, or null.
export function ownError(traceback, folder) {
  if (!traceback?.error) return null;
  const { frames } = traceback;
  const inProject = frame => frame.file.startsWith(`${folder}/`) && !LIBRARIES.test(frame.file) && !CAPTOR.test(frame.file);
  const project = frames.findLastIndex(inProject);
  if (project < 0 || project < frames.findLastIndex(frame => CAPTOR.test(frame.file))) return null;
  return { file: frames[project].file.slice(folder.length + 1), line: frames[project].line };
}

// "RuntimeError: Directory '…' does not exist" rather than an exit code; the
// part's name only when there are several.
export function describeFailure({ traceback, crashed, exitCode, signalCode, part }, several) {
  const name = several ? `[${part}] ` : '';
  if (traceback?.error) return `${name}${traceback.error.length > 200 ? `${traceback.error.slice(0, 200)}…` : traceback.error}`;
  return `${name}${crashed ? 'crashed' : `exit code ${exitCode ?? signalCode}`}`;
}
