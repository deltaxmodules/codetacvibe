// `codetac check`, step K1.3 (block C, step C2): the local setup that points
// to real things — a live payment key, a remote database or Supabase project,
// the app set to run as production. The development .env files are read only
// to classify each value (live or test, local or remote); the value itself is
// never returned, shown, stored or sent: a finding has the variable's name,
// the file, the line and the kind of fact.
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

// Files the app reads while developing. .env.production holds production
// values on purpose; examples hold no real ones.
const DEVELOPMENT = /^\.env(\.local|\.development|\.development\.local)?$/;
const LIVE_KEY = /^(?:sk|rk|pk)_live_/;
const DATABASE = /(?:^|_)(?:DATABASE|DB|POSTGRES(?:QL)?|PG|MYSQL|MONGO(?:DB)?|REDIS)(?:_[A-Z]+)*_(?:URL|URI|HOST|DSN)$|^(?:DB|PG|MYSQL|POSTGRES)_?HOST$/;
const SUPABASE = /SUPABASE.*_URL$/;
const PRODUCTION_FLAG = /^(?:NODE_ENV|FLASK_ENV|APP_ENV|ENVIRONMENT|ENV|PYTHON_ENV|RAILS_ENV)$/;
// Hosts of this computer, of a private network, or a Docker service name (no dot).
const LOCAL_HOST = /^(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|::1|\[::1\]|host\.docker\.internal|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|[^.:]+)$/i;

// NAME=value, with export, quotes and a comment after an unquoted value.
function assignments(text) {
  const found = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) return;
    let value = match[2].trim();
    const quoted = value.match(/^(["'])(.*)\1/);
    value = quoted ? quoted[2] : value.replace(/\s+#.*$/, '');
    found.push({ name: match[1], value, line: index + 1 });
  });
  return found;
}

// The host of a database address or of a plain host value; null when there is none
// (a file path, sqlite:, an empty value or a ${VARIABLE} to fill in).
function hostOf(value) {
  if (!value || /\$\{?[A-Za-z_]/.test(value) || /^(?:sqlite|file):/i.test(value)) return null;
  if (value.includes('://')) {
    try { return new URL(value.replace(/^[a-z+]+:\/\//i, 'http://')).hostname.replace(/^\[|\]$/g, '') || null; } catch { return null; }
  }
  return /^[A-Za-z0-9.-]+(?::\d+)?$/.test(value) ? value.replace(/:\d+$/, '') : null;
}
const isRemote = host => Boolean(host) && !LOCAL_HOST.test(host);

// [{ kind, variable, file, line }]: kind is live-key, remote-database,
// remote-supabase or production-mode.
export function environmentFacts(root, envPaths) {
  const facts = [];
  for (const file of envPaths.filter(path => DEVELOPMENT.test(basename(path)))) {
    let text;
    try { text = readFileSync(join(root, file), 'utf8'); } catch { continue; }
    for (const { name, value, line } of assignments(text)) {
      const fact = kind => facts.push({ kind, variable: name, file, line });
      if (LIVE_KEY.test(value)) fact('live-key');
      else if (SUPABASE.test(name) && isRemote(hostOf(value))) fact('remote-supabase');
      else if (DATABASE.test(name) && isRemote(hostOf(value))) fact('remote-database');
      else if (PRODUCTION_FLAG.test(name) && /^prod(?:uction)?$/i.test(value)) fact('production-mode');
    }
  }
  return facts;
}
