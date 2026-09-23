import { createServer as createViteServer } from 'vite';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
function calculate(value) { return value * 2; }
async function service(value) { await delay(4); return calculate(value); }
async function handler(req, res) {
  if (req.url === '/api/probe') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ value: await service(21) }));
  } else vite.middlewares(req, res);
}
const vite = await createViteServer({ root: import.meta.dirname, server: { middlewareMode: true }, appType: 'spa' });
createServer(handler).listen(Number(process.env.PORT), '127.0.0.1');
