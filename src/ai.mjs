// Camada de IA (Fase 3): frases de finalidade redigidas por um modelo a partir
// do código real e dos factos gravados. Configuração própria do CodeTAC:
//   CODETAC_AI_PROVIDER  auto (omissão) | nenhum | ollama | anthropic | openai | compativel
//   CODETAC_AI_MODEL     modelo; no modo auto escolhe um modelo local do Ollama
//   CODETAC_AI_KEY       chave (Anthropic, OpenAI ou compatível)
//   CODETAC_AI_URL       endereço do Ollama ou da API compatível
//   CODETAC_AI_CONFIG    ficheiro JSON com os mesmos campos (omissão: ia.json na pasta de dados do CodeTAC: ~/.codetac, ou .codetac/ num checkout)
//   CODETAC_LANG         idioma das explicações (pt-PT por omissão, ou en)
// Sem fornecedor, ficam as frases fixas. Tudo o que é enviado passa antes pela
// redação de segredos; cada frase recebida é validada contra os factos.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRedactor } from './redact.mjs';
import { language } from './sentences.mjs';

const PROMPT_VERSION = 6;
const OLLAMA_URL = 'http://127.0.0.1:11434';
// Local chat models preferred in auto mode, best first.
const OLLAMA_PREFERRED = [/^qwen2\.5-coder:14b/, /^qwen3:14b/, /^qwen3:8b/, /^qwen2\.5-coder:7b/, /^llama3\.[1-3]:8b/, /^gemma3/, /^mistral/];
const NOT_CHAT = /embed|bge|nomic|llava|vision|-vl|vl:|minicpm-v|smollm2:135m|:cloud|-cloud/;
const ANTHROPIC_MODEL = 'claude-opus-5';

export async function loadConfig({ env = process.env, directory } = {}) {
  let file = {};
  const path = env.CODETAC_AI_CONFIG || (directory ? join(directory, 'ia.json') : null);
  if (path && existsSync(path)) {
    try { file = JSON.parse(readFileSync(path, 'utf8')); } catch { file = {}; }
  }
  const pick = (name, key) => env[name] || file[key] || null;
  const provider = String(pick('CODETAC_AI_PROVIDER', 'provider') ?? 'auto').toLowerCase();
  const config = { provider, model: pick('CODETAC_AI_MODEL', 'model'), key: pick('CODETAC_AI_KEY', 'key'),
    url: pick('CODETAC_AI_URL', 'url'), lang: language(pick('CODETAC_LANG', 'lang') ?? undefined) };
  if (provider === 'nenhum' || provider === 'none') return { ...config, provider: null };
  if (provider === 'auto' || provider === 'ollama') {
    const url = config.url || OLLAMA_URL;
    const models = await ollamaModels(url);
    if (!models) return provider === 'ollama' ? { ...config, provider: null, problem: `Ollama não responde em ${url}.` } : { ...config, provider: null };
    const chat = models.filter(name => !NOT_CHAT.test(name));
    const model = config.model || OLLAMA_PREFERRED.map(pattern => chat.find(name => pattern.test(name))).find(Boolean) || chat[0];
    if (!model) return { ...config, provider: null, problem: 'O Ollama não tem nenhum modelo de conversa instalado.' };
    return { ...config, provider: 'ollama', url, model, local: /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url) };
  }
  if (provider === 'anthropic') {
    if (!config.key) return { ...config, provider: null, problem: 'Falta a chave da Anthropic (CODETAC_AI_KEY).' };
    return { ...config, model: config.model || ANTHROPIC_MODEL, local: false };
  }
  if (provider === 'openai' || provider === 'compativel') {
    if (!config.model) return { ...config, provider: null, problem: 'Falta o modelo (CODETAC_AI_MODEL).' };
    const url = config.url || (provider === 'openai' ? 'https://api.openai.com' : null);
    if (!url) return { ...config, provider: null, problem: 'Falta o endereço da API compatível (CODETAC_AI_URL).' };
    if (provider === 'openai' && !config.key) return { ...config, provider: null, problem: 'Falta a chave da OpenAI (CODETAC_AI_KEY).' };
    return { ...config, url, local: /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url) };
  }
  return { ...config, provider: null, problem: `Fornecedor desconhecido: ${provider}.` };
}

async function ollamaModels(url) {
  try {
    const response = await fetch(new URL('/api/tags', url), { signal: AbortSignal.timeout(800) });
    if (!response.ok) return null;
    return (await response.json()).models?.map(model => model.name) ?? [];
  } catch { return null; }
}

// What the panel shows about the configuration (never the key).
export function describeConfig(config) {
  if (!config?.provider) return { active: false, problem: config?.problem ?? null, lang: config?.lang ?? 'pt-PT' };
  return { active: true, provider: config.provider, model: config.model, local: Boolean(config.local), lang: config.lang };
}

// ---------------------------------------------------------------------------
// Prompt and schema
// ---------------------------------------------------------------------------

const SCHEMA = {
  type: 'object',
  properties: {
    finalidade: { type: 'string' },
    fronteiras: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, finalidade: { type: 'string' } },
      required: ['id', 'finalidade'], additionalProperties: false } },
  },
  required: ['finalidade', 'fronteiras'],
  additionalProperties: false,
};
const ACTION_SCHEMA = { type: 'object', properties: { finalidade: { type: 'string' } }, required: ['finalidade'], additionalProperties: false };

const GLOSSARY = 'Vocabulário de Portugal: base de dados (não banco de dados), pedido (não requisição), utilizador (não usuário), ficheiro (não arquivo), devolve (não retorna), procura (não busca), ecrã (não tela), sessão, palavra-passe (não senha).';
function instructions(lang) {
  const idiom = lang === 'en' ? 'English' : 'português de Portugal (não do Brasil)';
  return [
    ...(lang === 'en' ? [] : [GLOSSARY]),
    `Escreves frases de finalidade para quem não lê código com facilidade, em ${idiom}.`,
    'Recebes o código de uma função e os factos observados quando ela correu.',
    'Diz para que serve o passo, numa frase curta (no máximo 15 palavras), sem jargão de programação.',
    'Regras obrigatórias:',
    '- Não afirmes efeitos (gravar ou ler dados, emails, pagamentos, ficheiros, chamadas a serviços externos ou a IA) que não estejam nos factos observados, mesmo que o código os pudesse fazer.',
    '- Não menciones tabelas, serviços, domínios ou nomes que não apareçam nos factos ou no código.',
    '- Não inventes a razão de negócio: se o código não a mostra, descreve só o que o passo faz.',
    '- Descreve só o que aconteceu nesta execução. Não descrevas ramos alternativos do código («se não…», «caso contrário…»).',
    '- Não repitas números dos factos; eles já são mostrados ao lado.',
    'Responde só com JSON no formato pedido. Para cada fronteira indicada, dá uma frase curta que explique para que serve nesse passo.',
  ].join('\n');
}
function actionInstructions(lang) {
  const idiom = lang === 'en' ? 'English' : 'português de Portugal (não do Brasil)';
  return [
    `Resumes numa frase (no máximo 25 palavras), em ${idiom}, o que uma ação do utilizador numa aplicação faz, para quem não lê código.`,
    ...(lang === 'en' ? [] : [GLOSSARY]),
    'Usa só os factos dados: o elemento carregado, os pedidos, as finalidades dos passos e os efeitos observados.',
    'Não afirmes efeitos que não estejam nos efeitos observados. Não inventes a razão de negócio. Responde só com JSON.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

async function complete(config, system, user, schema) {
  const signal = AbortSignal.timeout(config.provider === 'ollama' ? 300_000 : 60_000);
  if (config.provider === 'ollama') {
    const response = await fetch(new URL('/api/chat', config.url), {
      method: 'POST', signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.model, stream: false, think: false, format: schema, options: { temperature: 0 },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    if (!response.ok) throw new Error(`Ollama: estado ${response.status}`);
    return JSON.parse((await response.json()).message?.content ?? '');
  }
  if (config.provider === 'anthropic') {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: config.key, maxRetries: 2 });
    const response = await client.beta.messages.create({
      model: config.model, max_tokens: 2000, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      system, messages: [{ role: 'user', content: user }],
    }, { signal });
    if (response.stop_reason === 'refusal') throw new Error('o modelo recusou o pedido');
    const text = response.content.find(block => block.type === 'text')?.text;
    return JSON.parse(text ?? '');
  }
  // OpenAI or any compatible API.
  const response = await fetch(new URL('/v1/chat/completions', config.url), {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', ...(config.key ? { authorization: `Bearer ${config.key}` } : {}) },
    body: JSON.stringify({ model: config.model,
      response_format: { type: 'json_schema', json_schema: { name: 'finalidade', strict: true, schema } },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  });
  if (!response.ok) throw new Error(`${config.provider}: estado ${response.status}`);
  return JSON.parse((await response.json()).choices?.[0]?.message?.content ?? '');
}

// ---------------------------------------------------------------------------
// Facts, validation
// ---------------------------------------------------------------------------

function walk(nodes, visit, parent = null) {
  for (const node of nodes) {
    visit(node, parent);
    walk(node.children ?? [], visit, node);
  }
}
function subtree(node) {
  const boundaries = [];
  const functions = [];
  walk(node.children ?? [], item => {
    if (item.type === 'boundary') boundaries.push(item);
    else if (item.type === 'function') functions.push(item);
  });
  return { boundaries, functions };
}

const CLAIMS = [
  // "the user's email" is data; sending one is the effect.
  { kinds: ['email', 'mensagem'], pattern: /\b(envi\w*|mand\w*|send\w*|dispar\w*)\b[^.;]{0,40}\b(e-?mails?|correio|mensage(m|ns)|sms|messages?|link)\b/i },
  { kinds: ['pagamento'], pattern: /\b(pagamentos?|payments?|cobran[çc]as?|charges?|stripe)\b/i },
  { kinds: ['ia'], pattern: /\b(IA|AI|LLM|OpenAI|Anthropic|Claude|GPT|intelig[êe]ncia artificial|language model|modelo de (linguagem|IA))\b/ },
  { kinds: ['ficheiros'], pattern: /\b(ficheiros?|arquivos?|files?|uploads?|S3|buckets?|armazenamento de ficheiros)\b/i },
  { kinds: ['base-de-dados'], pattern: /\b(base de dados|bases de dados|banco de dados|database|tabelas?|tables?|sql)\b/i },
  { kinds: ['http', 'ia', 'pagamento', 'email', 'mensagem', 'autenticação', 'ficheiros', 'base-de-dados'],
    pattern: /\b(servi[çc]o externo|API externa|external (service|API)|third-party)\b/i },
];
const WORD = /[\p{L}\p{N}_$.-]+/gu;
// "sem efeitos na base de dados", "não envia emails": a negation is not a claim.
function negated(text, index) {
  return /(^|[^\p{L}])(sem|não|nenhum\w*|nem|without|no|not|never|nunca)([^\p{L}][^.;]{0,30})?$/iu.test(text.slice(Math.max(0, index - 40), index));
}
const CONDITIONAL = /\b(caso contr[áa]rio|sen[ãa]o|se n[ãa]o (for|corresponder|coincidir|houver)|otherwise|if not|or else)\b/i;
const WRITE_VERBS = /\b(grava|gravar|guarda|guardar|regista|registar|insere|inserir|armazena|armazenar|persiste|atualiza|actualiza|apaga|elimina|saves?|stores?|persists?|inserts?|writes?|updates?|deletes?)\b/i;
const NOT_STORAGE = /\b(cookies?|browser|navegador|mem[óo]ria|memory|cache|vari[áa]ve(l|is)|variables?)\b/i;
// Tables named in SQL text inside the code: mentioning one that did not run is a claim.
export function tablesInCode(code) {
  return [...String(code ?? '').matchAll(/\b(?:from|into|update|join|table(?: if (?:not )?exists)?)\s+[`"[]?([A-Za-z_][\w]*)/gi)]
    .map(match => match[1].toLowerCase()).filter(name => !/^(select|if|not|exists|set|the|a|o)$/.test(name));
}

// A sentence may not claim what was not observed. Returns null when valid,
// or the reason it was rejected.
export function validateSentence(text, { boundaries, allowedWords, knownTables, knownHosts, maxLength = 280, conditionals = false }) {
  if (typeof text !== 'string' || !text.trim()) return 'frase vazia';
  if (text.length > maxLength) return 'frase demasiado longa';
  const branch = !conditionals && text.match(CONDITIONAL);
  if (branch) return `descreve um ramo que pode não ter corrido («${branch[0]}»)`;
  const kinds = new Set(boundaries.map(item => item.kind));
  // Writing verbs need an observed write (database or file), unless the
  // sentence is about the browser's cookies or memory.
  const writes = boundaries.some(item => (item.kind === 'base-de-dados' && /^(INSERT|UPDATE|DELETE|UPSERT|REPLACE|MERGE|CREATE|ALTER|DROP)$/.test(item.operation ?? ''))
    || (item.kind === 'ficheiros' && !['leitura', 'verificação'].includes(item.operation)) || ['email', 'mensagem', 'pagamento'].includes(item.kind));
  const verb = text.match(WRITE_VERBS);
  if (verb && !writes && !NOT_STORAGE.test(text) && !negated(text, verb.index)) return `diz «${verb[0]}» sem nenhuma escrita observada`;
  for (const claim of CLAIMS) {
    const match = text.match(claim.pattern);
    if (match && !claim.kinds.some(kind => kinds.has(kind)) && !negated(text, match.index)) return `menciona «${match[0]}» sem essa fronteira nos factos`;
  }
  const tables = new Set(boundaries.flatMap(item => item.tables ?? []).map(name => name.toLowerCase()));
  const hosts = new Set(boundaries.map(item => item.host).filter(Boolean).map(name => name.toLowerCase()));
  for (const raw of text.match(WORD) ?? []) {
    const word = raw.replace(/^[.-]+|[.-]+$/g, '');
    const lower = word.toLowerCase();
    // A table named like an ordinary word ("item", "user") only counts when
    // the sentence presents it as a table or quotes it.
    const asTable = /[_\d]/.test(word) || new RegExp(`(tabelas?|tables?)\\s+[\\'"«\`]?${lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b|[\\'"«\`]${lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\'"»\`]`, 'i').test(text);
    if (knownTables.has(lower) && !tables.has(lower) && asTable) return `menciona a tabela ${word}, que este passo não usou`;
    if (knownHosts.has(lower) && !hosts.has(lower)) return `menciona ${word}, que este passo não chamou`;
    // Identifier-like words (snake_case, camelCase, dotted names, `code`) must come from the facts or the code.
    const identifier = /[_$]/.test(word) || /[a-z][A-Z]/.test(word) || /\w\.\w/.test(word);
    if (identifier && !allowedWords.has(lower)) return `menciona ${word}, que não está nos factos nem no código`;
  }
  const quoted = [...text.matchAll(/`([^`]+)`/g)].map(match => match[1].toLowerCase());
  for (const item of quoted) if (!allowedWords.has(item)) return `menciona ${item}, que não está nos factos nem no código`;
  return null;
}

// Models often answer in Brazilian Portuguese despite the instruction; the
// most common forms are replaced (word by word, meaning unchanged).
const ARTICLES = { o: 'a', os: 'as', no: 'na', nos: 'nas', do: 'da', dos: 'das', ao: 'à', aos: 'às', um: 'uma', pelo: 'pela', a: 'o', as: 'os', na: 'no', nas: 'nos', da: 'do', das: 'dos', 'à': 'ao', 'às': 'aos', uma: 'um', pela: 'pelo' };
const swap = article => { const out = ARTICLES[article.toLowerCase()] ?? article; return article[0] === article[0].toUpperCase() ? out[0].toUpperCase() + out.slice(1) : out; };
const PT_PT = [
  // Gender changes: banco (m) → base (f); requisição (f) → pedido (m); tela (f) → ecrã (m).
  [/(?<!\p{L})(o|os|no|nos|do|dos|ao|aos|um|pelo) (banco|bancos) de dados(?!\p{L})/giu, (m, a, b) => `${swap(a)} base${b.endsWith('s') ? 's' : ''} de dados`],
  [/(?<!\p{L})(a|as|na|nas|da|das|à|às|uma|pela) (requisição|requisições)(?!\p{L})/giu, (m, a, r) => `${swap(a)} ${r.endsWith('ões') ? 'pedidos' : 'pedido'}`],
  [/(?<!\p{L})(a|as|na|nas|da|das|à|às|uma|pela) (tela|telas)(?!\p{L})/giu, (m, a, t) => `${swap(a)} ${t.endsWith('s') ? 'ecrãs' : 'ecrã'}`],
  [/\bbanco(s)? de dados\b/gi, 'base$1 de dados'], [/\brequisiç(ão|ões)\b/gi, (m, e) => e === 'ão' ? 'pedido' : 'pedidos'],
  [/\busuário(s)?\b/gi, 'utilizador$1'], [/\barquivo(s)?\b/gi, 'ficheiro$1'], [/\bretorna(m|r)?\b/gi, 'devolve$1'], [/\bbusca(m|r)?\b/gi, 'procura$1'],
  [/\btela(s)?\b/gi, 'ecrã$1'], [/\bregistra(r|m)?\b/gi, 'regista$1'], [/\bexclu[íi]d(o|a|os|as)\b/gi, 'eliminad$1'],
  [/\bexcluir\b/gi, 'eliminar'], [/\bexclui\b/gi, 'elimina'], [/\bsenha(s)?\b/gi, 'palavra$1-passe'], [/\bstatus\b/gi, 'estado']];
export function portuguese(text, lang) {
  if (lang === 'en' || typeof text !== 'string') return text;
  let out = text;
  for (const [pattern, replacement] of PT_PT) out = out.replace(pattern, (...args) => {
    const value = typeof replacement === 'function' ? replacement(...args) : args[0].replace(pattern, replacement);
    return args[0][0] === args[0][0].toUpperCase() ? value[0].toUpperCase() + value.slice(1) : value;
  });
  return out;
}

function wordsOf(...texts) {
  const words = new Set();
  for (const text of texts) for (const raw of String(text ?? '').match(WORD) ?? []) {
    const word = raw.replace(/^[.-]+|[.-]+$/g, '').toLowerCase();
    words.add(word);
    for (const part of word.split('.')) words.add(part);
  }
  return words;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Free questions about one step (Phase 4)
// ---------------------------------------------------------------------------

const ANSWER_SCHEMA = { type: 'object', properties: { sabe: { type: 'boolean' }, resposta: { type: 'string' } },
  required: ['sabe', 'resposta'], additionalProperties: false };
function questionInstructions(lang) {
  const idiom = lang === 'en' ? 'English' : 'português de Portugal (não do Brasil)';
  return [
    `Respondes, em ${idiom}, a uma pergunta de uma pessoa que não lê código com facilidade sobre um passo de uma aplicação.`,
    ...(lang === 'en' ? [] : [GLOSSARY]),
    'Usa só os factos dados: o código do passo, o que foi observado quando correu e, se existirem, os valores gravados e as linhas executadas.',
    'Se os factos não chegam para responder, põe "sabe": false e diz em «resposta» o que falta saber, sem supor.',
    'Não afirmes efeitos (gravar dados, emails, pagamentos, ficheiros, serviços externos) que não estejam nos factos observados.',
    'Distingue o que aconteceu nesta execução do que o código faria noutros casos; se falares de outros casos, di-lo explicitamente.',
    'Responde em no máximo 120 palavras, sem jargão. Responde só com JSON.',
  ].join('\n');
}

// One step of a request dossier (with its digest) and a question. Values
// and executed lines go to the model only when it runs on this machine.
export async function answerQuestion({ config, dossier, stepId, question, readCode, redact = createRedactor() }) {
  if (!config?.provider) return { available: false, text: 'As perguntas precisam de um modelo de IA configurado (ver «Frases de finalidade e modelo de IA» no README).' };
  let step = null;
  let parent = null;
  walk(dossier.digest.nodes, (node, holder) => { if (node.id === stepId) { step = node; parent = holder; } });
  if (!step) return { available: true, known: false, text: 'Este passo não foi encontrado no dossier.' };
  const target = step.type === 'function' ? step : parent?.type === 'function' ? parent : null;
  const code = target ? readCode(dossier.request.run, target.file, target.line, target.endLine) : null;
  const facts = target ? subtree(target) : { boundaries: [step], functions: [] };
  const withValues = Boolean(config.local);
  const lines = [
    `Pedido: ${dossier.request.method} ${dossier.request.path} (estado ${dossier.request.status ?? 'desconhecido'}).`,
    step.type === 'function' ? `Passo: função ${step.function} (${step.purpose.text}).` : `Passo: fronteira — ${step.purpose.text}${step.sql ? ` — SQL: ${step.sql}` : ''}${target ? `, dentro da função ${target.function}` : ''}.`,
    step.error ? 'O passo terminou com erro.' : '',
    facts.functions.length ? `Funções do projeto chamadas dentro dele: ${[...new Set(facts.functions.map(item => item.function))].slice(0, 30).join(', ')}.` : '',
    facts.boundaries.length ? `Fronteiras observadas:\n${facts.boundaries.slice(0, 40).map(item => `- ${item.purpose.text}${item.sql ? ` — SQL: ${item.sql.slice(0, 300)}` : ''}`).join('\n')}` : 'Nenhuma fronteira observada neste passo.',
  ];
  const detail = target?.detail;
  if (detail && withValues) {
    lines.push(`Valores gravados nesta chamada: argumentos ${JSON.stringify(detail.args).slice(0, 4000)}; ${'returned' in detail ? `devolveu ${JSON.stringify(detail.returned).slice(0, 4000)}` : `lançou ${JSON.stringify(detail.threw)}`}.`);
    lines.push(`Linhas executadas (do ficheiro original): ${detail.lines.join(', ') || 'nenhuma registada'}.`);
  } else if (detail) {
    lines.push(`Linhas executadas (do ficheiro original): ${detail.lines.join(', ') || 'nenhuma registada'}. Os valores gravados não são enviados a modelos fora desta máquina.`);
  } else {
    lines.push('Não há valores gravados para este passo (o detalhe não foi pedido).');
  }
  if (code) lines.push('', `Código (${target.function}, a partir da linha ${code.start}):`, redact(code.lines.join('\n')).slice(0, config.local ? 6000 : 12000));
  lines.push('', `Pergunta: ${String(question).slice(0, 1000)}`);
  const result = await complete(config, questionInstructions(config.lang), redact(lines.filter(line => line !== '').join('\n')), ANSWER_SCHEMA);
  const text = portuguese(String(result?.resposta ?? ''), config.lang);
  const knownTables = new Set([...dossier.digest.nodes.flatMap(node => { const all = []; walk([node], item => all.push(...(item.tables ?? []))); return all; }), ...tablesInCode(code?.lines.join('\n'))].map(name => name.toLowerCase()));
  const knownHosts = new Set();
  walk(dossier.digest.nodes, item => { if (item.host) knownHosts.add(item.host.toLowerCase()); });
  const allowedWords = wordsOf(code?.lines.join('\n'), question, ...lines);
  // Answers may talk about other cases of the code, so conditionals are allowed here.
  const rejected = validateSentence(text, { boundaries: facts.boundaries, allowedWords, knownTables, knownHosts, maxLength: 1500, conditionals: true });
  return { available: true, known: Boolean(result?.sabe), text, rejected, model: config.model, local: Boolean(config.local), valuesSent: Boolean(detail && withValues) };
}

export function createPurposes({ config, cache, readCode, redact = createRedactor(), limit = Number(process.env.CODETAC_AI_LIMIT || 40) }) {
  const jobs = new Map();

  function key(...parts) {
    return createHash('sha256').update(JSON.stringify([PROMPT_VERSION, config.provider, config.model, config.lang, ...parts])).digest('hex');
  }

  // One request per project function: its code, what it called and the
  // boundaries directly inside it.
  function tasksOf(dossiers) {
    const tasks = [];
    const knownTables = new Set();
    const knownHosts = new Set();
    for (const dossier of dossiers) {
      walk(dossier.digest.nodes, node => {
        for (const table of node.tables ?? []) knownTables.add(table.toLowerCase());
        if (node.host) knownHosts.add(node.host.toLowerCase());
      });
    }
    // Steps shown in the grouped view first (breadth first), then the rest;
    // the same function with the same facts is asked once.
    const candidates = [];
    for (const dossier of dossiers) {
      const queue = dossier.digest.nodes.map(node => ({ node, parent: null, shown: true, depth: 0 }));
      while (queue.length) {
        const { node, parent, shown, depth } = queue.shift();
        if (node.type === 'function' && parent?.type !== 'group') {
          const leaf = !node.children.length && !node.error && depth > 0;
          candidates.push({ node, dossier, shown: shown && !leaf, depth });
        }
        const open = node.type !== 'group' && busy(node);
        for (const child of node.children ?? []) queue.push({ node: child, parent: node, shown: shown && open, depth: depth + 1 });
      }
    }
    candidates.sort((a, b) => Number(b.shown) - Number(a.shown));
    const unique = new Map();
    const codes = new Map();
    for (const { node, dossier } of candidates) {
      const where = `${dossier.request.run}\n${node.file}\n${node.line}\n${node.endLine}`;
      if (!codes.has(where)) codes.set(where, readCode(dossier.request.run, node.file, node.line, node.endLine));
      const code = codes.get(where);
      if (!code) continue;
      const facts = subtree(node);
      const direct = node.children.filter(item => item.type === 'boundary');
      const task = { node, dossier, code: redact(code.lines.join('\n')).slice(0, config.local ? 6_000 : 12_000), facts, direct, knownTables, knownHosts, same: [] };
      const signature = taskKey(task);
      if (unique.has(signature)) unique.get(signature).same.push(task);
      else if (unique.size < limit) unique.set(signature, Object.assign(task, { signature }));
    }
    return [...unique.values()];
  }
  function busy(node) { return (node.children ?? []).some(child => child.type === 'boundary' || child.error || busy(child)); }
  function taskKey(task) {
    return key('function', [task.node.function, task.code, task.node.purpose.text.replace(/\d+/g, 'N'),
      task.facts.boundaries.map(item => item.purpose.text.replace(/\d+/g, 'N')), task.direct.map(item => item.purpose.text.replace(/\d+/g, 'N'))]);
  }

  function prompt(task) {
    const { node, facts, direct } = task;
    const lines = [
      `Função: ${node.function} (${task.code ? 'código abaixo' : 'sem código'})`,
      `Factos observados nesta execução: ${node.purpose.text}.`,
      facts.functions.length ? `Funções do projeto chamadas (por ordem): ${[...new Set(facts.functions.map(item => item.function))].slice(0, 30).join(', ')}.` : 'Não chamou outras funções do projeto.',
      facts.boundaries.length ? `Fronteiras observadas dentro desta função:\n${facts.boundaries.slice(0, 40).map(item => `- ${item.purpose.text.replace(/\d+/g, 'N')}${item.sql ? ` — SQL: ${item.sql.slice(0, 300)}` : ''}`).join('\n')}`
        : 'Nenhuma fronteira observada (não leu nem gravou dados, não enviou emails, não chamou serviços externos).',
      node.error ? 'A função terminou com erro.' : '',
      direct.length ? `Fronteiras a explicar (id — facto):\n${direct.map((item, index) => `- b${index + 1} — ${item.purpose.text.replace(/\d+/g, 'N')}`).join('\n')}` : 'Não há fronteiras a explicar: devolve "fronteiras": [].',
      '',
      'Código:',
      task.code,
    ];
    return redact(lines.filter(line => line !== '').join('\n'));
  }

  function check(text, task, boundaries) {
    const allowedWords = wordsOf(task.code, task.node.function, ...task.facts.functions.map(item => item.function),
      ...boundaries.flatMap(item => [...(item.tables ?? []), item.host, item.provider, item.sql]));
    const knownTables = new Set([...task.knownTables, ...tablesInCode(task.code)]);
    return validateSentence(text, { boundaries, allowedWords, knownTables, knownHosts: task.knownHosts });
  }

  async function run(task) {
    const cacheKey = task.signature;
    let answer = cache.get(cacheKey);
    if (!answer) {
      const result = await complete(config, instructions(config.lang), prompt(task), SCHEMA);
      answer = { finalidade: String(result?.finalidade ?? ''), fronteiras: (result?.fronteiras ?? []).map(item => ({ id: String(item.id), finalidade: String(item.finalidade ?? '') })) };
      cache.set(cacheKey, answer);
    }
    const out = {};
    answer = { finalidade: portuguese(answer.finalidade, config.lang), fronteiras: answer.fronteiras.map(item => ({ ...item, finalidade: portuguese(item.finalidade, config.lang) })) };
    const rejected = check(answer.finalidade, task, task.facts.boundaries);
    out[task.node.id] = rejected ? { source: 'factos', rejected, proposed: answer.finalidade } : { source: 'ia', text: answer.finalidade };
    task.direct.forEach((boundary, index) => {
      const proposal = (answer.fronteiras.find(item => item.id === boundary.id) ?? answer.fronteiras.find(item => item.id === `b${index + 1}`))?.finalidade;
      if (!proposal) return;
      const reason = check(proposal, task, [boundary]);
      out[boundary.id] = reason ? { source: 'factos', rejected: reason, proposed: proposal } : { source: 'ia', text: proposal };
    });
    // Identical calls of the same function get the same sentences.
    for (const other of task.same) {
      out[other.node.id] = out[task.node.id];
      other.direct.forEach((boundary, index) => { if (out[task.direct[index]?.id]) out[boundary.id] = out[task.direct[index].id]; });
    }
    return out;
  }

  async function actionSentence(action, dossiers, purposes) {
    const steps = [];
    for (const dossier of dossiers) walk(dossier.digest.nodes, (node, parent) => {
      if (node.type === 'function' && parent?.type !== 'group' && steps.length < 30) steps.push(`${node.function}: ${purposes[node.id]?.text ?? node.purpose.text}`);
    });
    const facts = [
      `Ação: ${action.digest.summary}.`,
      steps.length ? `Passos do servidor:\n${steps.map(item => `- ${item}`).join('\n')}` : 'Não houve passos do projeto no servidor.',
      `Efeitos observados: ${action.digest.effects.items.map(item => item.text).join('; ') || action.digest.effects.none}.`,
    ].join('\n');
    const cacheKey = key('action', facts.replace(/\d+/g, 'N'));
    let answer = cache.get(cacheKey);
    if (!answer) {
      answer = { finalidade: String((await complete(config, actionInstructions(config.lang), redact(facts), ACTION_SCHEMA))?.finalidade ?? '') };
      cache.set(cacheKey, answer);
    }
    answer = { finalidade: portuguese(answer.finalidade, config.lang) };
    const boundaries = dossiers.flatMap(dossier => { const all = []; walk(dossier.digest.nodes, node => { if (node.type === 'boundary') all.push(node); }); return all; });
    const knownTables = new Set(boundaries.flatMap(item => item.tables ?? []).map(name => name.toLowerCase()));
    const knownHosts = new Set(boundaries.map(item => item.host).filter(Boolean).map(name => name.toLowerCase()));
    const allowedWords = wordsOf(facts, action.label, ...dossiers.flatMap(dossier => [dossier.request.path]));
    const rejected = validateSentence(answer.finalidade, { boundaries, allowedWords, knownTables, knownHosts });
    return rejected ? { source: 'factos', rejected, proposed: answer.finalidade } : { source: 'ia', text: answer.finalidade };
  }

  // Starts (or continues) the generation for a dossier and returns what is
  // ready. The work goes on in the background between calls.
  function status(id, build) {
    let job = jobs.get(id);
    if (!job) {
      job = { purposes: {}, done: 0, total: null, errors: [], finished: false };
      jobs.set(id, job);
      job.promise = (async () => {
        try {
          const { dossiers, action } = await build();
          const tasks = tasksOf(dossiers);
          job.total = tasks.length + (action ? 1 : 0);
          const concurrency = config.provider === 'ollama' ? 1 : 4;
          let next = 0;
          await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
            while (next < tasks.length) {
              const task = tasks[next++];
              try { Object.assign(job.purposes, await run(task)); }
              catch (error) { job.errors.push(`${task.node.function}: ${error.message}`); }
              job.done++;
            }
          }));
          if (action) {
            try { job.purposes.action = await actionSentence(action, dossiers, job.purposes); }
            catch (error) { job.errors.push(`ação: ${error.message}`); }
            job.done++;
          }
        } catch (error) {
          job.errors.push(error.message);
        } finally {
          job.finished = true;
          // A finished job is kept a short while; the answers stay in the cache.
          setTimeout(() => jobs.delete(id), 60_000).unref();
        }
      })();
    }
    return { purposes: job.purposes, done: job.done, total: job.total, finished: job.finished, errors: job.errors.slice(0, 5) };
  }

  return { status, wait: id => jobs.get(id)?.promise };
}
