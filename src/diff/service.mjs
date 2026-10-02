// The Diff in the panel (phase D3): what the bar's «What changed?» button,
// the report page (/diff) and the history ask. A project is named by a
// recording (run, its folder is the recording's) or, without an app running,
// by the id of its Diff folder (project, from /api/diff/projects).
//   GET  /api/diff/projects          the projects with prompts recorded
//   GET  /api/diff/state             the newest prompt: running, waiting, done; its badge
//   GET  /api/diff/prompts           the history: every prompt, newest first, with its badge
//   GET  /api/diff/report?n=         the report of a prompt (report.mjs)
//   POST /api/diff/seen {n, keys}    the report was opened; these sentences were read
//   GET  /api/diff/request?n=        the Request layer (phase D4): the interpretation of the
//                                    prompt and its comparison by the rules; whether the AI may be asked
//   GET  /api/diff/request/preview?n= the exact request to the AI (sending needs its fingerprint)
//   POST /api/diff/request {n, hash} asks the AI to read the prompt (Privacy: «requests»)
//   POST /api/diff/request/edit {n, prediction}  the user's own version of the request
//   GET  /api/diff/behavior?n=       the Behavior layer (phase D5): the actions run before and after
//                                    the prompt, what each does differently, its path on the plan;
//                                    for those not run since, how to run them again (phase D6)
//   GET  /api/diff/undo?n=&action=   the preview of undoing (or redoing) a whole prompt (phase D6)
//   POST /api/diff/undo {n, action, hash}  does it, with the fingerprint of the preview seen
// The badge of a prompt: how many changes, alerts, warnings and "possibly",
// how many of its sentences were not opened yet (comprehension debt) and,
// once the prompt was interpreted, how many changes were outside the request.
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirectory } from '../home.mjs';
import { blocked, blockedText, guarded } from '../privacy.mjs';
import { t } from '../structure/text.mjs';
import { diffFolder, writeWhole } from './archive.mjs';
import { hooksStatus } from './install.mjs';
import { describePrompt } from './moments.mjs';
import { listPrompts, readPrompt } from './prompts.mjs';
import { promptBehavior } from './behavior.mjs';
import { promptReport } from './report.mjs';
import { applySwitch, previewSwitch } from './undo.mjs';
import { editedPrediction, interpretationInput, interpretPrompt, readInterpretation, requestChoices, requestLayer, saveInterpretation } from './request.mjs';

const PROJECT_ID = /^[0-9a-f]{32}$/;
const MAX_REPORTS = 40;
export const sentenceKey = sentence => `${sentence.kind}\n${sentence.text}`;

// The project of a Diff folder, or null; the folder's id must be the one of that project.
export function projectById(id) {
  if (!PROJECT_ID.test(id ?? '')) return null;
  try {
    const { root } = JSON.parse(readFileSync(join(dataDirectory(), 'diff', id, 'project.json'), 'utf8'));
    const real = realpathSync(root);
    return diffFolder(real).endsWith(id) ? real : null;
  } catch { return null; }
}

export function listProjects() {
  let ids = [];
  try { ids = readdirSync(join(dataDirectory(), 'diff')).filter(id => PROJECT_ID.test(id)); } catch {}
  const projects = [];
  for (const id of ids) {
    const root = projectById(id);
    if (!root) continue;
    const prompts = listPrompts(root);
    if (!prompts.length) continue;
    projects.push({ id, name: root.split('/').pop(), prompts: prompts.length, last: prompts.at(-1).startedAt });
  }
  return projects.sort((a, b) => (a.last < b.last ? 1 : -1));
}

const seenPath = root => join(diffFolder(root), 'seen.json');
function readSeen(root) {
  try { return JSON.parse(readFileSync(seenPath(root), 'utf8')) ?? {}; } catch { return {}; }
}

export function createDiffService({ rootOf = () => null, ai = null, recordings = null } = {}) {
  const reports = new Map();

  // Whether the AI may read a prompt now: a model, and the Privacy switch.
  function aiState() {
    if (!ai?.config?.provider) return { active: false, problem: ai?.config?.problem ?? t('service.noModel') };
    const reason = blocked('requests', ai.config);
    if (reason) return { active: false, blocked: reason, problem: blockedText(reason) };
    return { active: true, provider: ai.config.provider, model: ai.config.model, local: Boolean(ai.config.local) };
  }
  // The outside-the-request count of a prompt, once interpreted.
  async function outsideOf(root, prompt) {
    if (!prompt.after || !readInterpretation(root, prompt.n)) return null;
    const layer = await requestLayer(root, prompt.n);
    return layer?.comparison ? layer.comparison.outside : null;
  }

  // A closed prompt's report never changes: kept in memory by its moments.
  async function reportOf(root, prompt) {
    if (!prompt.after) return promptReport(root, prompt.n);
    const key = `${root}\n${prompt.n}\n${prompt.before}\n${prompt.after}`;
    if (!reports.has(key)) {
      reports.set(key, promptReport(root, prompt.n));
      if (reports.size > MAX_REPORTS) reports.delete(reports.keys().next().value);
    }
    const report = await reports.get(key);
    if (report.error) reports.delete(key);
    return report;
  }

  function badgeOf(report, seen, outside = null) {
    if (!report || report.error) return null;
    const read = new Set(seen?.keys ?? []);
    const count = severity => report.sentences.filter(sentence => sentence.severity === severity).length;
    return { changes: report.sentences.length, alerts: count('alert'), warnings: count('warning'),
      possibly: report.sentences.filter(sentence => sentence.origin === 'possibly').length,
      unread: report.sentences.filter(sentence => !read.has(sentenceKey(sentence))).length, opened: Boolean(seen?.opened),
      ...(outside === null ? {} : { outside }) };
  }

  function rootFrom(params) {
    const run = params.get('run');
    if (run) return rootOf(run) ?? null;
    return projectById(params.get('project'));
  }

  async function handle(pathname, params, { method = 'GET', body = null } = {}) {
    if (pathname === '/api/diff/projects') return { status: 200, body: { projects: listProjects() } };
    const root = rootFrom(params);
    if (!root) return { status: 404, body: { error: t('prompts.service.noProject') } };
    let real;
    try { real = realpathSync(root); } catch { return { status: 404, body: { error: t('prompts.service.noProject') } }; }
    const project = { id: diffFolder(real).split('/').pop(), name: real.split('/').pop() };
    if (pathname === '/api/diff/state') {
      const latest = listPrompts(real).at(-1) ?? null;
      let hooks = false;
      try { hooks = hooksStatus(real).installed.length > 0; } catch {}
      const badge = latest?.after && latest.status === 'done' ? badgeOf(await reportOf(real, latest), readSeen(real)[latest.n], await outsideOf(real, latest)) : null;
      return { status: 200, body: { project, hooks, latest: latest ? describePrompt(latest) : null, badge } };
    }
    if (pathname === '/api/diff/prompts') {
      const seen = readSeen(real);
      const prompts = [];
      for (const prompt of listPrompts(real).reverse()) {
        const badge = prompt.after && prompt.status !== 'running' && prompt.status !== 'waiting' ? badgeOf(await reportOf(real, prompt), seen[prompt.n], await outsideOf(real, prompt)) : null;
        prompts.push({ ...describePrompt(prompt), badge });
      }
      return { status: 200, body: { project, prompts } };
    }
    if (pathname === '/api/diff/report') {
      const wanted = params.get('n') || 'latest';
      const prompt = readPrompt(real, wanted === 'latest' ? 'latest' : Number(wanted));
      if (!prompt) return { status: 404, body: { error: t('prompts.noPrompt', { n: wanted }) } };
      const report = await reportOf(real, prompt);
      if (report.error) return { status: 404, body: { error: report.error } };
      const all = listPrompts(real).map(item => item.n);
      const at = all.indexOf(prompt.n);
      const seen = readSeen(real)[prompt.n];
      const read = new Set(seen?.keys ?? []);
      return { status: 200, body: { project, ...report,
        // The prompt as the log has it now (a kept report does not know it was undone since).
        prompt: { ...describePrompt(prompt), text: prompt.text },
        sentences: report.sentences.map(sentence => ({ ...sentence, key: sentenceKey(sentence), read: read.has(sentenceKey(sentence)) })),
        previous: at > 0 ? all[at - 1] : null, next: at >= 0 && at < all.length - 1 ? all[at + 1] : null, badge: badgeOf(report, seen, await outsideOf(real, prompt)) } };
    }
    if (pathname === '/api/diff/seen') {
      if (method !== 'POST') return { status: 405, body: { error: t('service.usePost') } };
      const n = Number(body?.n);
      if (!readPrompt(real, n)) return { status: 404, body: { error: t('prompts.noPrompt', { n: body?.n }) } };
      const keys = Array.isArray(body?.keys) ? body.keys.filter(key => typeof key === 'string' && key.length < 2000).slice(0, 500) : [];
      const seen = readSeen(real);
      const entry = seen[n] ?? { opened: false, keys: [] };
      entry.opened = true;
      entry.keys = [...new Set([...entry.keys, ...keys])];
      seen[n] = entry;
      writeWhole(seenPath(real), `${JSON.stringify(seen)}\n`);
      return { status: 200, body: { n, opened: true, read: entry.keys.length } };
    }
    if (pathname.startsWith('/api/diff/request')) return requestRoute(real, pathname, params, method, body);
    if (pathname === '/api/diff/behavior') {
      const wanted = params.get('n') || 'latest';
      const prompt = readPrompt(real, wanted === 'latest' ? 'latest' : Number(wanted));
      if (!prompt) return { status: 404, body: { error: t('prompts.noPrompt', { n: wanted }) } };
      const behavior = await promptBehavior(real, prompt.n, recordings);
      if (behavior.error) return { status: 404, body: { error: behavior.error } };
      return { status: 200, body: { n: prompt.n, recordings: Boolean(recordings), ...behavior } };
    }
    if (pathname === '/api/diff/undo') {
      const post = method === 'POST';
      const action = (post ? body?.action : params.get('action')) === 'redo' ? 'redo' : 'undo';
      const wanted = post ? body?.n : params.get('n');
      const prompt = readPrompt(real, wanted === 'latest' || wanted == null ? 'latest' : Number(wanted));
      if (!prompt) return { status: 404, body: { error: t('prompts.noPrompt', { n: wanted ?? 'latest' }) } };
      if (!post) {
        const plan = previewSwitch(real, prompt.n, action);
        return { status: 200, body: { n: prompt.n, action, ...plan, skipped: plan.skipped?.map(item => ({ ...item, text: t(`undo.why.${item.why}`) })) } };
      }
      if (typeof body?.hash !== 'string') return { status: 409, body: { error: t('undo.previewChanged') } };
      const done = applySwitch(real, prompt.n, action, body.hash);
      if (done.refused) return { status: 409, body: { error: done.refused, reason: done.reason } };
      return { status: 200, body: { ...done, skipped: done.skipped.map(item => ({ ...item, text: t(`undo.why.${item.why}`) })) } };
    }
    return { status: 404, body: { error: t('panel.api.notFound') } };
  }

  // The Request layer (phase D4). The AI only reads the prompt; the rules compare.
  async function requestRoute(real, pathname, params, method, body) {
    const post = method === 'POST';
    const wanted = post ? body?.n : params.get('n');
    const prompt = readPrompt(real, wanted === 'latest' || wanted == null ? 'latest' : Number(wanted));
    if (!prompt) return { status: 404, body: { error: t('prompts.noPrompt', { n: wanted ?? 'latest' }) } };
    const layer = async () => ({ n: prompt.n, layer: await requestLayer(real, prompt.n), ai: aiState(), canAsk: Boolean(prompt.after && prompt.text.trim()) });
    if (pathname === '/api/diff/request') {
      if (!post) return { status: 200, body: await layer() };
      const state = aiState();
      if (!state.active) return { status: 409, body: { error: state.problem, blocked: state.blocked ?? null } };
      if (!prompt.after) return { status: 409, body: { error: t('ai.request.running') } };
      if (typeof body?.hash !== 'string') return { status: 409, body: { error: t('service.factsChanged') } };
      let result;
      try { result = await interpretPrompt({ root: real, n: prompt.n, config: ai.config, complete: guarded('requests', ai.complete), hash: body.hash }); } catch (error) {
        return { status: 502, body: { error: t('service.noAnswer', { reason: String(error?.message ?? error).slice(0, 200) }) } };
      }
      if (result.error) return { status: result.changed ? 409 : 404, body: { error: result.error } };
      return { status: 200, body: await layer() };
    }
    if (pathname === '/api/diff/request/preview') {
      const state = aiState();
      if (!state.active) return { status: 200, body: state };
      if (!prompt.after) return { status: 409, body: { error: t('ai.request.running') } };
      const input = await interpretationInput(real, prompt.n);
      if (input.error) return { status: 404, body: { error: input.error } };
      return { status: 200, body: { ...state, ...input.request } };
    }
    if (pathname === '/api/diff/request/edit') {
      if (!post) return { status: 405, body: { error: t('service.usePost') } };
      if (!prompt.after) return { status: 409, body: { error: t('ai.request.running') } };
      const input = await interpretationInput(real, prompt.n);
      const choices = input.error ? requestChoices(real, { nodes: [] }) : input.choices;
      const previous = readInterpretation(real, prompt.n);
      saveInterpretation(real, prompt.n, { source: 'user', provider: previous?.provider ?? null, model: previous?.model ?? null,
        at: new Date().toISOString(), ...(previous ? { from: previous.source } : {}), prediction: editedPrediction(body?.prediction, choices) });
      return { status: 200, body: await layer() };
    }
    return { status: 404, body: { error: t('panel.api.notFound') } };
  }

  return { handle };
}
