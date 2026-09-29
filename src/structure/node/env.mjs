// Environment variables (phase 5, step 1): where each is defined (.env*
// files, by name only) and where it is read (process.env.X, import.meta.env.X,
// read by modules.mjs). The values of the .env files are never kept: each line
// is reduced to its name as it is read. Principle 4 of the specification.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_PROOFS = 12;
// Names that hold secrets, and keys made to be public (they never alert).
const SECRET_NAME = /SECRET|KEY|TOKEN|PASSWORD|PASSWD|SERVICE_ROLE|PRIVATE|CREDENTIAL/i;
const PUBLIC_BY_DESIGN = /(^|_)(ANON|PUBLISHABLE)_KEY$|(^|_)PUBLIC_KEY$/i;

// The browser prefixes of the frameworks of the project (step 2 adds the
// project's own settings, such as Vite's envPrefix).
export function publicPrefixes(types, extra = [], { vite = null } = {}) {
  const prefixes = new Set(extra);
  for (const type of types) {
    if (type.startsWith('next')) prefixes.add('NEXT_PUBLIC_');
    if (type.startsWith('vite')) for (const prefix of vite ?? ['VITE_']) prefixes.add(prefix);
    if (type === 'create-react-app') prefixes.add('REACT_APP_');
    if (type === 'nuxt') prefixes.add('NUXT_PUBLIC_');
    if (type === 'sveltekit' || type === 'astro') prefixes.add('PUBLIC_');
  }
  return [...prefixes];
}

// Vite's envPrefix (vite.config.*), which replaces VITE_: a text or a list.
export function vitePrefixes(root) {
  for (const name of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts', 'vite.config.cjs']) {
    let text;
    try { text = readFileSync(join(root, name), 'utf8'); } catch { continue; }
    const match = text.match(/envPrefix\s*:\s*(\[[^\]]*\]|'[^']*'|"[^"]*")/);
    if (!match) return null;
    const prefixes = [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map(item => item[1]).filter(Boolean);
    return prefixes.length ? prefixes : null;
  }
  return null;
}

// A service_role key is a secret whatever else its name says.
export const isSecretLike = name => /SERVICE_ROLE/i.test(name) || (SECRET_NAME.test(name) && !PUBLIC_BY_DESIGN.test(name));

// Names defined in a .env file, with their lines. The value after "=" is
// dropped at once.
export function definedNames(text) {
  const names = [];
  text.split('\n').forEach((line, index) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match) names.push({ name: match[1], line: index + 1 });
  });
  return names;
}

// { nodes, edges, defined, read } for the project's variables.
export function environment(root, files, modules, { types = [], prefixes = null } = {}) {
  const publicWith = prefixes ?? publicPrefixes(types, [], { vite: vitePrefixes(root) });
  const variables = new Map();
  const edges = new Map();
  const variable = name => {
    if (!variables.has(name)) {
      variables.set(name, { id: `env:${name}`, kind: 'env', name, public: publicWith.some(prefix => name.startsWith(prefix)),
        secretLike: isSecretLike(name), origin: 'static', proof: [], defined: [], read: [] });
    }
    return variables.get(name);
  };
  const addProof = (list, proof) => { if (list.length < MAX_PROOFS && !list.some(item => item.file === proof.file && item.line === proof.line)) list.push(proof); };
  for (const file of files.filter(item => item.language === 'dotenv')) {
    let text = '';
    try { text = readFileSync(join(root, file.path), 'utf8'); } catch { continue; }
    for (const { name, line } of definedNames(text)) {
      const entry = variable(name);
      addProof(entry.proof, { file: file.path, line });
      addProof(entry.defined, { file: file.path, line });
    }
    text = '';
  }
  for (const file of files) {
    for (const { name, line } of modules.get(file.path)?.env ?? []) {
      const entry = variable(name);
      addProof(entry.proof, { file: file.path, line });
      addProof(entry.read, { file: file.path, line });
      const kind = entry.secretLike ? 'uses-secret' : 'reads';
      const id = `${kind}:file:${file.path}->${entry.id}`;
      if (!edges.has(id)) edges.set(id, { id, kind, from: `file:${file.path}`, to: entry.id, origin: 'static', proof: [] });
      addProof(edges.get(id).proof, { file: file.path, line });
    }
  }
  const nodes = [...variables.values()].map(({ defined, read, ...node }) => node);
  return { nodes, edges: [...edges.values()], variables: [...variables.values()] };
}

// Keys written in the code (phase 5, step 4), as notes of the graph: the kind
// and the public prefix only, never the value (modules.mjs keeps no value).
const KEY_LABELS = {
  'stripe-live': 'A live Stripe secret key (sk_live_…)', 'stripe-test': 'A test Stripe secret key (sk_test_…)',
  'stripe-webhook': 'A Stripe webhook secret (whsec_…)', anthropic: 'An Anthropic API key (sk-ant-…)', openai: 'An OpenAI API key (sk-…)',
  aws: 'An AWS access key (AKIA…)', github: 'A GitHub token (ghp_…)', slack: 'A Slack token (xox…)', google: 'A Google API key (AIza…)',
  sendgrid: 'A SendGrid API key (SG.…)', 'private-key': 'A private key (-----BEGIN … PRIVATE KEY-----)',
  'supabase-service-role': 'A Supabase service_role key (a JWT with role service_role)',
};
export function literalKeyNotes(files, modules) {
  const notes = [];
  for (const file of files) {
    if (file.language === 'dotenv') continue;
    for (const { kind, line } of modules.get(file.path)?.keys ?? []) {
      notes.push({ kind: 'literal-key', message: `${KEY_LABELS[kind] ?? 'A key'} is written in the code, in ${file.path}. Its value is not shown.`,
        proof: [{ file: file.path, line }] });
    }
  }
  return notes;
}
