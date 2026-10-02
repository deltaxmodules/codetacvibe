// `codetac diff [n] [folder]` and `codetac diff --list` (phase D1, step 6):
// what a prompt changed — its files and, by the rules of the Changes view
// (phase 9), its structure — from the moments archived just before and just
// after it. A prompt still running is compared with the folder as it is now.
// The panel (Changes view) shows the same with the plan; the bar's button
// comes in phase D3.
import { realpathSync } from 'node:fs';
import { t, TEXT } from '../structure/text.mjs';
import { archiveMoment, diffFolder, fileChanges, readMoment } from './archive.mjs';
import { hooksStatus } from './install.mjs';
import { promptReport } from './report.mjs';
import { listPrompts, readPrompt } from './prompts.mjs';

const LISTED = 20;
const FILES_SHOWN = 30;
const when = iso => `${iso.replace('T', ' ').slice(0, 16)} UTC`;
const status = prompt => t(`prompts.cli.status.${prompt.status}`);

function noPrompts(root, out) {
  out(t('prompts.cli.none'));
  let installed = false;
  try { installed = hooksStatus(root).installed.length > 0; } catch {}
  out(`  ${t(installed ? 'prompts.cli.noneYet' : 'prompts.cli.install')}`);
  out('');
}

// The files of a prompt: { before, after (a moment), changes } — "after" is
// the folder now while the prompt has not ended.
function filesOf(root, prompt) {
  const before = readMoment(root, prompt.before);
  const afterId = prompt.after ?? archiveMoment(root).moment.id;
  const after = readMoment(root, afterId);
  if (!before || !after) return null;
  return { afterId, changes: fileChanges(before, after) };
}

function listCommand(root, out) {
  const prompts = listPrompts(root);
  if (!prompts.length) { noPrompts(root, out); return 0; }
  out(t('prompts.cli.listTitle', { count: prompts.length }));
  for (const prompt of prompts.slice(-LISTED).reverse()) {
    const files = filesOf(root, prompt);
    const count = files ? files.changes.added.length + files.changes.removed.length + files.changes.changed.length : null;
    const text = prompt.text.length > 70 ? `${prompt.text.slice(0, 69)}…` : prompt.text;
    out(`  ${String(prompt.n).padStart(3)}  ${when(prompt.startedAt)}  ${status(prompt)}  ${count === null ? '' : t('prompts.cli.files', { count })}  «${text.replace(/\s+/g, ' ')}»`);
  }
  if (prompts.length > LISTED) out(`  ${t('prompts.cli.older', { count: prompts.length - LISTED })}`);
  out(`  ${t('prompts.cli.seeOne')}`);
  out('');
  return 0;
}

const MARK = { alert: '!!', warning: '! ', info: '· ' };
const CODE_SHOWN = 400;

function printCode(report, out) {
  out(t('prompts.cli.codeTitle'));
  let shown = 0;
  for (const file of report.code.files) {
    out(`  ${t(`prompts.cli.code.${file.status}`, { path: file.path })}${file.note ? ` ${t(`prompts.cli.code.note.${file.note}`)}` : ''}`);
    for (const hunk of file.hunks) {
      const why = report.code.unexplained.includes(hunk.id) ? t('prompts.cli.code.unexplained') : t('prompts.cli.code.explains', { list: hunk.sentences.map(index => index + 1).join(', ') });
      out(`    @@ -${hunk.before.start},${hunk.before.count} +${hunk.after.start},${hunk.after.count} @@ #${hunk.id + 1} · ${why}`);
      for (const [op, text] of hunk.lines) {
        if (shown++ >= CODE_SHOWN) continue;
        out(`    ${op}${text}`);
      }
    }
  }
  if (shown > CODE_SHOWN) out(`  ${t('prompts.cli.code.cut', { count: shown - CODE_SHOWN })}`);
}

export async function diffCommand(root, { n = 'latest', list = false, code = false, out = text => process.stdout.write(`${text}\n`) } = {}) {
  root = realpathSync(root);
  if (list) return listCommand(root, out);
  if (!listPrompts(root).length) { noPrompts(root, out); return 0; }
  const prompt = readPrompt(root, n);
  if (!prompt) { out(`✗ ${t('prompts.noPrompt', { n })}`); out(`  ${t('prompts.cli.seeList')}`); out(''); return 2; }
  out(t('prompts.cli.title', { n: prompt.n, date: when(prompt.startedAt), status: status(prompt) }));
  out(`  «${prompt.text}»`);
  if (prompt.status === 'running') out(`  ${t('prompts.cli.running')}`);
  if (prompt.status === 'waiting') out(`  ${t('prompts.cli.waiting')}`);
  if (prompt.status === 'interrupted') out(`  ${t('prompts.cli.interrupted')}`);
  if (prompt.overlap) out(`  ! ${t('prompts.cli.overlap')}`);
  const report = await promptReport(root, prompt.n);
  if (report.error) { out(`✗ ${report.error}`); out(''); return 2; }
  const { added, removed, changed } = report.files;
  out('');
  out(t('prompts.cli.filesTitle', { added: added.length, changed: changed.length, removed: removed.length }));
  const rows = [...added.map(path => `+ ${path}`), ...changed.map(path => `~ ${path}`), ...removed.map(path => `- ${path}`)];
  if (!rows.length) out(`  ${t('prompts.cli.noFiles')}`);
  for (const row of rows.slice(0, FILES_SHOWN)) out(`  ${row}`);
  if (rows.length > FILES_SHOWN) out(`  ${t('prompts.cli.moreFiles', { count: rows.length - FILES_SHOWN })}`);
  out('');
  out(t('prompts.cli.structureTitle'));
  if (!report.sentences.length) out(`  ${TEXT.diff.nothing}`);
  report.sentences.forEach((sentence, index) => {
    const touches = sentence.touches.length ? ` [${sentence.touches.join(', ')}]` : '';
    const origin = sentence.origin === 'possibly' ? ` (${t('prompts.cli.possibly')})` : '';
    out(`  ${String(index + 1).padStart(2)}. ${MARK[sentence.severity]} ${sentence.text}${origin}${touches}`);
    const proof = sentence.proof.slice(0, 3).map(item => `${item.file}:${item.line}`);
    const blocks = sentence.blocks.length ? ` · ${t('prompts.cli.blocks', { list: sentence.blocks.slice(0, 6).map(id => `#${id + 1}`).join(' ') })}` : '';
    if (proof.length) out(`        ${t(sentence.side === 'before' ? 'cli.diff.wasAt' : 'cli.diff.at')} ${proof.join(', ')}${sentence.proof.length > 3 ? ', …' : ''}${blocks}`);
  });
  const blocks = report.code.files.reduce((sum, file) => sum + file.hunks.length, 0);
  out('');
  out(t('prompts.cli.codeSummary', { count: blocks, files: report.code.files.length, other: report.code.unexplained.length }));
  if (code) printCode(report, out);
  else if (blocks) out(`  ${t('prompts.cli.seeCode', { n: prompt.n })}`);
  if (report.missing.length) out(`  ! ${t('prompts.notStored', { count: report.missing.length, list: report.missing.slice(0, 3).join(', ') })}`);
  for (const problem of report.problems) out(`  ! ${problem}`);
  out(`  ${t('prompts.cli.onPanel', { n: prompt.n })}`);
  out('');
  return 0;
}

// Where the panel shows a prompt's report: { path } or { error } (phase D3, `codetac diff --open`).
export function reportAddress(root, n = 'latest') {
  root = realpathSync(root);
  const prompt = listPrompts(root).length ? readPrompt(root, n) : null;
  if (!prompt) return { error: listPrompts(root).length ? t('prompts.noPrompt', { n }) : t('prompts.cli.none') };
  archiveMoment(root);
  return { path: `/diff?run=project:${diffFolder(root).split('/').pop()}&n=${prompt.n}` };
}
