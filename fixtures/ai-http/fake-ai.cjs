// Imitação local da API da OpenAI e da Anthropic, sem captura: responde
// comprimido quando o cliente o aceita (como os fornecedores reais).
const http = require('node:http');
const zlib = require('node:zlib');

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const payload = JSON.parse(body || '{}');
    if (payload.stream) {
      res.setHeader('content-type', 'text/event-stream');
      res.write('data: {"type":"content_block_delta","delta":{"text":"Pedido "}}\n\n');
      setTimeout(() => res.end('data: {"type":"content_block_delta","delta":{"text":"aprovado"}}\n\n'
        + 'data: {"type":"message_delta","usage":{"input_tokens":14,"output_tokens":2}}\n\n'), 30);
      return;
    }
    const answer = JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion', created: 0, model: payload.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Categoria: faturação.' } }],
      usage: { prompt_tokens: 42, completion_tokens: 4, total_tokens: 46 } });
    const accepts = String(req.headers['accept-encoding'] ?? '');
    res.setHeader('content-type', 'application/json');
    if (/\bbr\b/.test(accepts)) { res.setHeader('content-encoding', 'br'); res.end(zlib.brotliCompressSync(answer)); }
    else if (/gzip/.test(accepts)) { res.setHeader('content-encoding', 'gzip'); res.end(zlib.gzipSync(answer)); }
    else res.end(answer);
  });
});
server.listen(Number(process.env.FAKE_AI_PORT), '127.0.0.1');
