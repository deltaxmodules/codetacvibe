// Ensaio da Etapa 3 da v2: chamadas de IA feitas com axios (http/https) e com
// o SDK oficial da OpenAI (fetch), contra uma imitação local da API.
const { spawn } = require('node:child_process');
const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');

const aiPort = Number(process.env.PORT) + 1;
const { NODE_OPTIONS, ...plain } = process.env;
spawn(process.execPath, [require.resolve('./fake-ai.cjs')], { env: { ...plain, FAKE_AI_PORT: String(aiPort) }, stdio: 'inherit' });
const base = `http://127.0.0.1:${aiPort}/v1`;
const key = process.env.AI_KEY ?? 'sk-proj-chave-do-ensaio-7788';
const openai = new OpenAI({ apiKey: key, baseURL: base });

async function classifyTicket(text) {
  const { data } = await axios.post(`${base}/chat/completions`,
    { model: 'gpt-axios', messages: [{ role: 'user', content: `Classifica: ${text}` }] },
    { headers: { authorization: `Bearer ${key}` } });
  return data.choices[0].message.content;
}

async function streamDecision(text) {
  const { data } = await axios.post(`${base}/messages`,
    { model: 'claude-axios', stream: true, max_tokens: 50, messages: [{ role: 'user', content: `Decide: ${text}` }] },
    { headers: { 'x-api-key': key }, responseType: 'stream' });
  let answer = '';
  for await (const chunk of data) answer += chunk;
  return answer;
}

async function summarizeWithSdk(text) {
  const completion = await openai.chat.completions.create({ model: 'gpt-sdk', messages: [{ role: 'user', content: `Resume: ${text}` }] });
  return completion.choices[0].message.content;
}

const app = express();
app.use(express.json());
app.get('/health', (req, res) => res.send('ok'));
app.post('/api/tickets', async (req, res) => res.json({ category: await classifyTicket(req.body.text) }));
app.post('/api/decisions', async (req, res) => res.json({ raw: await streamDecision(req.body.text) }));
app.post('/api/summaries', async (req, res) => res.json({ summary: await summarizeWithSdk(req.body.text) }));
app.listen(Number(process.env.PORT), '127.0.0.1');
