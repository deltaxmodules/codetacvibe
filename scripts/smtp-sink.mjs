// Recetor SMTP local para ensaios: aceita mensagens e descarta o conteúdo.
// Uso: node scripts/smtp-sink.mjs [porta] [ficheiro]   (predefinição 2525)
// Com um ficheiro, guarda nele a última mensagem (por exemplo, para um ensaio
// seguir um link de login enviado por email). Esse ficheiro é só do ensaio.
import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';

const port = Number(process.argv[2] || 2525);
const output = process.argv[3];
let received = 0;
createServer(socket => {
  let data = false;
  let buffer = '';
  let message = [];
  socket.write('220 codetac-sink ESMTP\r\n');
  socket.on('data', chunk => {
    buffer += chunk.toString('latin1');
    let index;
    while ((index = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (data) {
        if (line === '.') {
          data = false;
          received++;
          if (output) writeFileSync(output, message.join('\n'), { mode: 0o600 });
          message = [];
          socket.write(`250 OK mensagem ${received}\r\n`);
        } else message.push(line);
        continue;
      }
      const command = line.slice(0, 4).toUpperCase();
      if (command === 'EHLO') socket.write('250-codetac-sink\r\n250 8BITMIME\r\n');
      else if (command === 'HELO' || command === 'MAIL' || command === 'RCPT' || command === 'RSET' || command === 'NOOP') socket.write('250 OK\r\n');
      else if (command === 'DATA') { data = true; socket.write('354 Fim com <CRLF>.<CRLF>\r\n'); }
      else if (command === 'QUIT') { socket.end('221 Adeus\r\n'); }
      else socket.write('502 Não suportado\r\n');
    }
  });
  socket.on('error', () => {});
}).listen(port, '127.0.0.1', () => console.log(`Recetor SMTP em 127.0.0.1:${port}`));
