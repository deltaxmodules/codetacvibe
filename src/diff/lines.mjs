// The lines that changed in a file (phase D2, step 4): the shortest edit
// script between two versions (Myers' algorithm), grouped into blocks with a
// few lines of context, as a "git diff" shows them. Lines are compared whole;
// the common start and end are taken out first, so a small change in a long
// file costs little. Past MAX_EDITS differences the middle is shown as all
// removed and all added (a rewrite), which is what it is.
export const CONTEXT = 3;
const MAX_EDITS = 4000;

export function splitLines(text) {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map(line => line.replace(/\r$/, ''));
}

// The middle part: [op, text] with op ' ' (same), '-' (only before), '+' (only after).
function middle(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n) return b.map(line => ['+', line]);
  if (!m) return a.map(line => ['-', line]);
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) return [...a.map(line => ['-', line]), ...b.map(line => ['+', line])];
  // Back through the trace: the moves, last first.
  const ops = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const previous = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && previous[offset + k - 1] < previous[offset + k + 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = previous[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push([' ', a[--x]]); y--; }
    if (down) ops.push(['+', b[--y]]); else ops.push(['-', a[--x]]);
  }
  while (x > 0 && y > 0) { ops.push([' ', a[--x]]); y--; }
  return ops.reverse();
}

// [op, text] for every line of both versions.
export function diffLines(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  return [
    ...before.slice(0, start).map(line => [' ', line]),
    ...middle(before.slice(start, before.length - end), after.slice(start, after.length - end)),
    ...before.slice(before.length - end).map(line => [' ', line]),
  ];
}

// The blocks of changes: { before: { start, count }, after: { start, count },
// lines: [[op, text]], added, removed } — lines numbered from 1, as editors
// do; a block of a new file starts before at line 0.
export function hunks(ops, context = CONTEXT) {
  const result = [];
  let oldLine = 1;
  let newLine = 1;
  const numbered = ops.map(([op, text]) => {
    const item = { op, text, old: op === '+' ? null : oldLine, new: op === '-' ? null : newLine };
    if (op !== '+') oldLine++;
    if (op !== '-') newLine++;
    return item;
  });
  let index = 0;
  while (index < numbered.length) {
    if (numbered[index].op === ' ') { index++; continue; }
    let first = Math.max(0, index - context);
    let last = index;
    // Changes closer than twice the context join the same block.
    for (let next = index; next < numbered.length; next++) {
      if (numbered[next].op !== ' ') last = next;
      else if (next - last > 2 * context) break;
    }
    const end = Math.min(numbered.length - 1, last + context);
    const lines = numbered.slice(first, end + 1);
    const olds = lines.filter(line => line.old !== null).map(line => line.old);
    const news = lines.filter(line => line.new !== null).map(line => line.new);
    result.push({
      before: { start: olds[0] ?? (lines[0].new !== null ? Math.max(0, (numbered.slice(0, first).filter(line => line.old !== null).at(-1)?.old ?? 0)) : 0), count: olds.length },
      after: { start: news[0] ?? (numbered.slice(0, first).filter(line => line.new !== null).at(-1)?.new ?? 0), count: news.length },
      lines: lines.map(line => [line.op, line.text]),
      added: lines.filter(line => line.op === '+').length,
      removed: lines.filter(line => line.op === '-').length,
    });
    index = end + 1;
  }
  return result;
}
