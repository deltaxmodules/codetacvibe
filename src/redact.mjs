const sensitive = /password|secret|token|authorization|api[ _-]?key|credential|private[ _-]?key|session/i;
const marker = '[REDACTED]';
// A name (field, parameter, function) that announces a secret.
export const isSensitiveName = name => sensitive.test(String(name ?? ''));
const MIN_SECRET_LENGTH = 8;

export function createRedactor(env = process.env, maxBytes = 10 * 1024) {
  const secrets = Object.entries(env)
    // Very short values ("1", "true") are flags, not secrets; matching them
    // would destroy unrelated text such as paths and numbers.
    .filter(([key, value]) => sensitive.test(key) && typeof value === 'string' && value.length >= MIN_SECRET_LENGTH)
    .map(([, value]) => value).sort((a, b) => b.length - a.length);
  function text(value) {
    for (const secret of secrets) value = value.split(secret).join(marker);
    value = value
      .replace(/Bearer\s+[^\s"',;]+/gi, `Bearer ${marker}`)
      .replace(/-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*?-----END [\w ]*PRIVATE KEY-----/g, marker)
      .replace(/\b(?:sk-(?:proj-|ant-)?[\w-]{8,}|gh[pousr]_[\w]{10,}|github_pat_[\w]{10,}|AKIA[A-Z0-9]{16}|AIza[\w-]{20,}|xox[baprs]-[\w-]{10,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, marker)
      .replace(/((?:password|secret|token|authorization|api[ _-]?key|credential|private[ _-]?key|session)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, `$1${marker}`)
      .replace(/\b([\w.+-])[\w.+-]*@([\w-])[\w.-]*\.[a-z]{2,}\b/gi, '$1***@$2***')
      .replace(/(?<![\w])\+?\d[\d ()-]{7,}\d(?![\w])/g, match => `${match.slice(0, 2)}***${match.slice(-2)}`);
    if (Buffer.byteLength(value) > maxBytes) {
      value = Buffer.from(value).subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/, '') + '[TRUNCATED]';
    }
    return value;
  }
  return function redact(value) {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [text(key), sensitive.test(key) ? marker : redact(item)]),
    );
    return value;
  };
}
