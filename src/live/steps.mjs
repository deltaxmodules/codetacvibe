// Live mode, phase L4a: the actions of a prompt grouped into steps of the
// system, so the window shows "login page", "users table", not one line per
// command. Worked out again from the events whenever they are read (the
// steps are never stored: better rules give better steps for old sessions).
//
// Two ways, as the specification says:
//   - tasks: the assistant made a task list (TaskCreate/TaskUpdate, or
//     TodoWrite): each task is a step, with the assistant's own status
//     (pending → "Next", in progress → "Now", completed → "Done");
//   - areas: no task list: one step per area of the project (interface,
//     server, database, configuration, tests), in the order they first
//     appear, named by what was done in it ("Interface: login page, header").
//     The newest area worked on is "Now", the others are done.
// Reading and looking through the project belong to the step in progress
// (before any step, they are "Now" on their own). Every action keeps the
// event it came from, for the technical details (L4b).
import { t } from '../structure/text.mjs';

const PLANNING = new Set(['task-create', 'task-start', 'task-done', 'task-update', 'task-read', 'todo', 'plan-mode', 'skill']);
const AREA_ORDER = ['interface', 'server', 'database', 'configuration', 'tests', 'other'];
const MAX_TOPICS = 3;

const placeOf = event => event.input?.file ?? event.input?.command ?? event.input?.url ?? '';
// One action of a step, for the technical details (V7): what it was, where, the files it created, changed or
// removed, and whether it worked. Never what a command printed nor what a file holds.
function action(event, sentence) {
  const input = event.input ?? {};
  const files = [];
  if (input.file && ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(event.tool)) files.push({ path: input.file, change: event.tool === 'Write' ? 'written' : 'changed' });
  for (const path of input.writes ?? []) files.push({ path, change: 'written' });
  for (const path of input.deletes ?? []) files.push({ path, change: 'removed' });
  return { id: event.id, text: sentence.text, rule: sentence.rule, area: sentence.area, place: placeOf(event), at: event.at, tool: event.tool, ok: null, files };
}

export function areaLabel(area, topics = []) {
  // "other" is a plural form in the text file: the area is called "setup" there.
  const name = t(`live.area.${area === 'other' ? 'setup' : area}`);
  return topics.length ? t('live.step.label', { area: name, topics: topics.slice(0, MAX_TOPICS).join(', ') }) : name;
}

export function groupSteps(rows) {
  const usesTasks = rows.some(({ event, sentence }) => event.kind === 'start' && ['task-create', 'todo'].includes(sentence?.rule));
  return usesTasks ? byTasks(rows) : byAreas(rows);
}

// Ends and failures say whether an action worked.
function settle(actions, event) {
  const found = actions.get(event.id);
  if (!found) return;
  if (event.kind === 'end') {
    found.ok = true;
    // Write says in its result whether the file was new.
    if (event.result?.change) for (const file of found.files) if (file.path === event.input?.file) file.change = event.result.change;
  }
  if (event.kind === 'fail') found.ok = false;
}

function byTasks(rows) {
  const steps = [];
  const byKey = new Map();
  const loose = [];
  const actions = new Map();
  let current = null;
  const stepFor = (key, label) => {
    if (!byKey.has(key)) { const step = { key, label, status: 'pending', from: 'task', actions: [] }; byKey.set(key, step); steps.push(step); }
    return byKey.get(key);
  };
  for (const { event, sentence } of rows) {
    if (event.kind === 'end' || event.kind === 'fail') {
      settle(actions, event);
      // The task's id only comes in the result of TaskCreate.
      if (event.kind === 'end' && event.tool === 'TaskCreate' && event.result?.task) stepFor(event.result.task, event.input?.subject ?? '');
      continue;
    }
    if (event.kind !== 'start' || !sentence) continue;
    if (event.tool === 'TodoWrite' && Array.isArray(event.input?.todos)) {
      for (const todo of event.input.todos) {
        if (!todo?.content) continue;
        const step = stepFor(todo.content, todo.content);
        step.status = todo.status === 'completed' ? 'done' : todo.status === 'in_progress' ? 'current' : 'pending';
        if (step.status === 'current') current = step;
      }
      continue;
    }
    if (event.tool === 'TaskUpdate') {
      const step = byKey.get(event.input?.task);
      if (!step) continue;
      if (event.input?.subject) step.label = event.input.subject;
      if (event.input?.status === 'in_progress') { step.status = 'current'; current = step; }
      else if (event.input?.status === 'completed') { step.status = 'done'; if (current === step) current = null; }
      else if (event.input?.status === 'deleted') { steps.splice(steps.indexOf(step), 1); byKey.delete(step.key); if (current === step) current = null; }
      continue;
    }
    if (PLANNING.has(sentence.rule) || sentence.waiting) continue;
    const item = action(event, sentence);
    actions.set(event.id, item);
    (current ? current.actions : loose).push(item);
  }
  return { mode: 'tasks', steps, loose, current };
}

function byAreas(rows) {
  const steps = [];
  const byArea = new Map();
  const loose = [];
  const actions = new Map();
  let current = null;
  for (const { event, sentence } of rows) {
    if (event.kind === 'end' || event.kind === 'fail') { settle(actions, event); continue; }
    if (event.kind !== 'start' || !sentence || PLANNING.has(sentence.rule) || sentence.waiting) continue;
    const item = action(event, sentence);
    actions.set(event.id, item);
    // A shell line that wrote several files counts in the area of each file (and its own, when it did more).
    const parts = sentence.files?.length ? [...(sentence.rule.startsWith('file-') || sentence.rule === 'cmd-write-files' ? [] : [sentence]), ...sentence.files] : [sentence];
    for (const part of parts) {
      let area = part.area;
      // Looking and other work belong to the step in progress.
      if (area === 'analysis' || (area === 'other' && current)) { (current ? current.actions : loose).push(item); continue; }
      if (!AREA_ORDER.includes(area)) area = 'other';
      if (!byArea.has(area)) { const step = { key: area, area, topics: [], status: 'done', from: 'area', actions: [], paths: [] }; byArea.set(area, step); steps.push(step); }
      const step = byArea.get(area);
      if (part.topic && !step.topics.includes(part.topic)) step.topics.push(part.topic);
      if (!step.actions.includes(item)) step.actions.push(item);
      // The step's own files (the plan opens on the first): of a shell line that wrote several, those of this area.
      const own = part.path ? [part.path] : sentence.files?.length ? [] : item.files.filter(file => file.change !== 'removed').map(file => file.path);
      for (const path of own) if (!step.paths.includes(path)) step.paths.push(path);
      current = step;
    }
  }
  for (const step of steps) { step.label = areaLabel(step.area, step.topics); step.status = step === current ? 'current' : 'done'; }
  return { mode: 'areas', steps, loose, current };
}
