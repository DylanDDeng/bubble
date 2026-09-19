// Minimal real stdio server for lifecycle regression tests.
const fs = require('node:fs');
const mode = process.argv[2];
fs.writeFileSync(process.argv[3], String(process.pid));
if (mode === 'exit') process.exit(7);
if (mode === 'silent') {
  process.stdin.resume();
} else {
  let buffer = Buffer.alloc(0);
  process.stdin.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
      if (buffer.length < end + 4 + length) return;
      const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length));
      buffer = buffer.subarray(end + 4 + length);
      if (message.method === 'exit') process.exit(0);
      if (message.id === undefined) continue;
      if (message.method !== 'initialize' && mode === 'request-hang') continue;
      if (message.method !== 'initialize' && mode === 'request-exit') process.exit(8);
      // More than a pipe's capacity; the client must drain stderr.
      if (message.method === 'initialize' && mode === 'noisy') fs.writeSync(2, 'x'.repeat(512 * 1024));
      const result = message.method === 'initialize' ? { capabilities: {} } : null;
      const body = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
      process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    }
  });
}
