// An optional AI explanation of a block's card (phase 3, step 4). The model
// receives only the facts of the card (sentences built from the structure),
// never code. The user sees the exact request first; the request that is sent
// is rebuilt from the same facts and must have the same fingerprint, so what
// is sent is what was shown. The answer is checked: every file, function,
// route or block it names must be in the facts sent, or it is rejected.
import { createHash } from 'node:crypto';
import { createRedactor } from '../redact.mjs';

export const PROMPT_VERSION = 1;
const MAX_LENGTH = 1200;
const SECTION_TITLES = { purpose: 'What it is for', usedBy: 'Used by', uses: 'Uses', data: 'Data it touches', largest: 'Largest files',
  entries: 'Entry points', notes: 'Could not be decided' };

export const SYSTEM = [
  'You explain one block of a web project to someone who does not read code easily, for a map of the project.',
  'You get only facts about the block, read from its structure; you never see its code.',
  'In at most 120 words of plain English, say what the block is for and how it connects to the rest.',
  'Use only the facts given. Do not add files, functions, routes, tables, services or effects that are not in them.',
  'Write every name of a file, folder, function, route or block exactly as in the facts, between backticks (`like/this.js`).',
  'If the facts do not say something, do not guess it. Answer only with JSON.',
].join('\n');

export const SCHEMA = { type: 'object', additionalProperties: false, required: ['explanation'], properties: { explanation: { type: 'string' } } };

// The exact request: { system, text, hash }.
export function explanationRequest(card, project = {}) {
  const redact = createRedactor();
  const lines = [`Project: ${project.name ?? 'unnamed'}${project.types?.length ? ` (${project.types.join(', ')})` : ''}`, `Block: ${card.name}`, '', 'Facts:'];
  for (const [section, title] of Object.entries(SECTION_TITLES)) {
    const facts = card.facts.filter(fact => fact.section === section);
    if (!facts.length) continue;
    lines.push(`${title}:`);
    for (const fact of facts) lines.push(`- ${fact.text}`);
  }
  const text = redact(lines.join('\n'));
  const hash = createHash('sha256').update(`${PROMPT_VERSION}\n${SYSTEM}\n${text}`).digest('hex').slice(0, 32);
  return { system: SYSTEM, text, hash };
}

// Words that look like names in code: paths, file names, camelCase,
// snake_case, calls, and routes.
const NAME_LIKE = /(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY) \/[^\s`,;)]*|[\w@.-]*\/[\w@./:[\]()*-]*|\b[\w-]+\.(?:m?[jt]sx?|cjs|json|html?|sql|css|md|prisma|env)\b|\b[a-z]+[A-Z][\w]*\b|\b\w+_\w+\b|\b\w+\(\)/g;
const trim = word => word.replace(/^[\s.,;:!?'"«»(]+|[\s.,;:!?'"«»)]+$/g, '').replace(/\(\)$/, '');

// null when the explanation only names what is in the request, else why not.
export function checkExplanation(explanation, request, card) {
  if (typeof explanation !== 'string' || !explanation.trim()) return 'The explanation is empty.';
  if (explanation.length > MAX_LENGTH) return 'The explanation is too long.';
  const allowed = new Set([...card.names, ...(request.text.match(NAME_LIKE) ?? []).map(trim)].map(name => name.toLowerCase()));
  const known = word => {
    const lower = trim(word).toLowerCase();
    return !lower || allowed.has(lower) || request.text.toLowerCase().includes(lower);
  };
  for (const match of explanation.matchAll(/`([^`]+)`/g)) {
    if (!known(match[1])) return `It names \`${match[1]}\`, which is not in the facts sent.`;
  }
  const plain = explanation.replace(/`[^`]*`/g, ' ');
  for (const word of plain.match(NAME_LIKE) ?? []) {
    // In prose, "client/server" is not a path: only dotted or rooted ones are.
    const clean = trim(word);
    if (clean.includes('/') && !/^[A-Z]+ \//.test(clean) && !clean.includes('.') && !clean.startsWith('/') && !clean.endsWith('/')) continue;
    if (!known(word)) return `It names ${clean}, which is not in the facts sent.`;
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
