// An optional AI explanation of a block's card (phase 3, step 4). The model
// receives only the facts of the card (sentences built from the structure),
// never code. The user sees the exact request first; the request that is sent
// is rebuilt from the same facts and must have the same fingerprint, so what
// is sent is what was shown. The answer is checked: every file, function,
// route or block it names must be in the facts sent, or it is rejected.
// Phase 10, step 1: the same for the whole plan ("explain this plan in five
// lines") and for one alert; their facts come from facts.mjs.
import { createHash } from 'node:crypto';
import { createRedactor } from '../redact.mjs';
import { TEXT, t } from './text.mjs';

export const PROMPT_VERSION = 1;
// The instructions, the section titles and the headings live in text/en.json (ai.explain).
const E = TEXT.ai.explain;
export const SYSTEM = E.system.block;

// What is explained: a block's card (phase 3), the plan or one alert (phase 10).
export const KINDS = {
  block: { system: E.system.block, titles: E.titles.block, heading: E.headings.block, max: 1200 },
  plan: { system: E.system.plan, titles: E.titles.plan, heading: E.headings.plan, max: 900 },
  alert: { system: E.system.alert, titles: E.titles.alert, heading: E.headings.alert, max: 900 },
};

export const SCHEMA = { type: 'object', additionalProperties: false, required: ['explanation'], properties: { explanation: { type: 'string' } } };

// The exact request: { system, text, hash, kind }. `card` is { name, facts:
// [{ section, text }], names } (a block's card, or facts.mjs for the others).
export function explanationRequest(card, project = {}, kind = 'block') {
  const { system, titles, heading } = KINDS[kind];
  const redact = createRedactor();
  const lines = [t('ai.explain.project', { name: project.name ?? t('ai.explain.unnamed'), types: project.types?.length ? ` (${project.types.join(', ')})` : '' }), `${heading}: ${card.name}`, '', t('ai.explain.facts')];
  for (const [section, title] of Object.entries(titles)) {
    const facts = card.facts.filter(fact => fact.section === section);
    if (!facts.length) continue;
    lines.push(`${title}:`);
    for (const fact of facts) lines.push(`- ${fact.text}`);
  }
  const text = redact(lines.join('\n'));
  const hash = createHash('sha256').update(`${PROMPT_VERSION}\n${system}\n${text}`).digest('hex').slice(0, 32);
  return { system, text, hash, kind };
}

// Words that look like names in code: paths, file names, camelCase,
// snake_case, calls, and routes.
const NAME_LIKE = /(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY) \/[^\s`,;)]*|[\w@.-]*\/[\w@./:[\]()*-]*|\b[\w-]+\.(?:m?[jt]sx?|cjs|json|html?|sql|css|md|prisma|env)\b|\b[a-z]+[A-Z][\w]*\b|\b\w+_\w+\b|\b\w+\(\)/g;
const trim = word => word.replace(/^[\s.,;:!?'"«»(]+|[\s.,;:!?'"«»)]+$/g, '').replace(/\(\)$/, '');

// null when the explanation only names what is in the request, else why not.
export function checkExplanation(explanation, request, card) {
  if (typeof explanation !== 'string' || !explanation.trim()) return t('ai.explain.empty');
  if (explanation.length > KINDS[request.kind ?? 'block'].max) return t('ai.explain.tooLong');
  const allowed = new Set([...card.names, ...(request.text.match(NAME_LIKE) ?? []).map(trim)].map(name => name.toLowerCase()));
  const known = word => {
    const lower = trim(word).toLowerCase();
    return !lower || allowed.has(lower) || request.text.toLowerCase().includes(lower);
  };
  for (const match of explanation.matchAll(/`([^`]+)`/g)) {
    if (!known(match[1])) return t('ai.explain.namesQuoted', { name: match[1] });
  }
  const plain = explanation.replace(/`[^`]*`/g, ' ');
  for (const word of plain.match(NAME_LIKE) ?? []) {
    // In prose, "client/server" is not a path: only dotted or rooted ones are.
    const clean = trim(word);
    if (clean.includes('/') && !/^[A-Z]+ \//.test(clean) && !clean.includes('.') && !clean.startsWith('/') && !clean.endsWith('/')) continue;
    if (!known(word)) return t('ai.explain.names', { name: clean });
  }
  return null;
}

// Asks the model for the explanation of a card. `complete(config, system,
// text, schema)` is the AI layer's call. Returns { explanation } or
// { rejected }.
export async function explainCard({ config, request, card, complete }) {
  const answer = await complete(config, request.system, request.text, SCHEMA);
  const explanation = String(answer?.explanation ?? '').trim();
  const problem = checkExplanation(explanation, request, card);
  return problem ? { rejected: problem } : { explanation };
}
