// Serves the reference front end (fe/index.html) on http://localhost:8790. localhost is in the
// extension's externally_connectable list, so the page can talk to it. Run: pnpm fe
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const PORT = 8790;
createServer((req, res) => {
  if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/') return res.writeHead(404).end('not found');
  res.writeHead(200, { 'content-type': 'text/html' }).end(readFileSync(new URL('../fe/index.html', import.meta.url)));
}).listen(PORT, '127.0.0.1', () => console.log(`VIN Flow demo front end on http://localhost:${PORT}`));
