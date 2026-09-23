// Aplicação de exemplo sem framework para a Fase 2: HTML e JavaScript simples,
// handlers com addEventListener, pedidos com fetch e XMLHttpRequest, e uma
// navegação que carrega um documento novo.
import http from 'node:http';
import { readFileSync } from 'node:fs';

const saved = [];
const page = title => `<!doctype html>
<html lang="pt"><head><meta charset="utf-8"><title>${title}</title>
<style>body { font: 16px system-ui; margin: 40px; } button, a { margin-right: 12px; }</style></head>
<body><h1>${title}</h1>
<p><button id="guardar">Guardar nota</button><button id="alternar">Mostrar detalhes</button><a id="outra" href="/outra">Outra página</a></p>
<p id="estado">pronto</p><ul id="lista"></ul><div id="detalhes" hidden>Detalhes da nota.</div>
<script src="/app.js"></script></body></html>`;

function saveNote(text) {
  saved.push({ text, at: Date.now() });
  return saved.length;
}
function listNotes() {
  return saved.map(note => note.text);
}
function handler(request, response) {
  if (request.url === '/' || request.url === '/outra') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page(request.url === '/' ? 'Notas' : 'Outra página'));
  } else if (request.url === '/app.js') {
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    response.end(readFileSync(new URL('./app.js', import.meta.url)));
  } else if (request.url === '/api/notas' && request.method === 'POST') {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const count = saveNote(JSON.parse(body).text);
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ count }));
    });
  } else if (request.url === '/api/notas') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(listNotes()));
  } else if (request.url === '/api/visitas') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"visitas":1}');
  } else {
    response.writeHead(404);
    response.end();
  }
}
http.createServer(handler).listen(Number(process.env.PORT || 3200), '127.0.0.1');
