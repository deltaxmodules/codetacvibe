// `codetac live replay [session] [folder] [--json]` (phase L2): the sentences
// of a recorded session, from its events, by the rules of rules.mjs; then how
// many actions got one, and the actions no rule knows (to write the next
// rule). Without a session, the newest of the project.
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { diffFolder } from '../diff/archive.mjs';
import { hooksStatus } from '../diff/install.mjs';
import { t } from '../structure/text.mjs';
import { ingest, liveFolder, readSession } from './events.mjs';
import { translateSession } from './rules.mjs';
import { groupSteps } from './steps.mjs';

const sessionsOf = root => {
  const folder = join(liveFolder(root), 'sessions');
  try {
    return readdirSync(folder).filter(name => name.endsWith('.jsonl'))
      .map(name => ({ id: name.slice(0, -'.jsonl'.length), time: statSync(join(folder, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
  } catch { return []; }
};

// The numbers of a translated session: actions (starts, failures, notices), translated, generic, unknown.
export function coverage(rows) {
  const actions = rows.filter(row => row.event.kind !== 'end');
  const unknown = actions.filter(row => !row.sentence);
  return {
    actions: actions.length,
    translated: actions.length - unknown.length,
    generic: actions.filter(row => row.sentence?.generic).length,
    unknown: unknown.map(row => ({ tool: row.event.tool ?? row.event.kind, what: row.event.input?.command ?? row.event.input?.file ?? '' })),
  };
}

const time = at => (at ? new Date(at).toTimeString().slice(0, 8) : '        ');
const where = event => event.input?.file ?? event.input?.command ?? event.input?.subject ?? '';

// Where the live window of a project is, and a warning when its hooks are not installed.
export function liveAddress(root) {
  root = realpathSync(root);
  const status = hooksStatus(root);
  const id = basename(diffFolder(root));
  return { path: `/live?project=${id}`, warning: status.error || !status.current ? t('live.cli.noHooks') : null };
}

export function liveCommand(root, { action = 'replay', session = null, json = false, out = text => process.stdout.write(`${text}\n`) } = {}) {
  root = realpathSync(root);
  if (action !== 'replay') { out(t('live.cli.usage')); return 2; }
  // What is still waiting from a session in progress is read first.
  try { ingest(root); } catch {}
  const sessions = sessionsOf(root);
  const id = session ?? sessions[0]?.id;
  if (!id) { out(t('live.cli.none')); return 1; }
  const events = readSession(root, id);
  if (!events.length) { out(t('live.cli.unknownSession', { id, count: sessions.length })); return 1; }
  const rows = translateSession(events);
  const numbers = coverage(rows);
  if (json) { out(JSON.stringify({ session: id, rows, coverage: numbers, steps: groupSteps(rows) }, null, 2)); return 0; }
  out(t('live.cli.heading', { id, count: events.length }));
  for (const { event, sentence } of rows) {
    if (event.kind === 'end') continue;
    const mark = event.kind === 'fail' ? '✗' : sentence ? ' ' : '?';
    const text = sentence ? sentence.text : t('live.cli.noRule', { tool: event.tool ?? event.kind });
    out(`${time(event.at)} ${mark} ${text.padEnd(52)} ${sentence ? `[${sentence.rule}]`.padEnd(22) : ''.padEnd(22)} ${String(where(event)).slice(0, 70)}`);
  }
  const percent = numbers.actions ? Math.round((100 * numbers.translated) / numbers.actions) : 100;
  out('');
  out(t('live.cli.coverage', { translated: numbers.translated, actions: numbers.actions, percent, generic: numbers.generic }));
  if (numbers.unknown.length) {
    out(t('live.cli.unknownHeading', { count: numbers.unknown.length }));
    for (const item of numbers.unknown) out(`  ${item.tool}: ${String(item.what).slice(0, 100)}`);
  }
  // The steps of each prompt of the session (L4a).
  const prompts = [...new Set(events.map(event => event.prompt).filter(Boolean))];
  for (const prompt of prompts) {
    const grouping = groupSteps(rows.filter(row => row.event.prompt === prompt));
    out('');
    out(t(grouping.mode === 'tasks' ? 'live.cli.stepsTasks' : 'live.cli.stepsAreas', { count: grouping.steps.length }));
    for (const step of grouping.steps) out(`  ${step.status === 'done' ? '✓' : step.status === 'current' ? '›' : '○'} ${step.label}  ${t('live.cli.actions', { count: step.actions.length })}`);
  }
  if (sessions.length > 1 && !session) out(t('live.cli.others', { count: sessions.length - 1 }));
  return 0;
}
