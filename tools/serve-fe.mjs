// Serves the reference front end on http://localhost:8790. localhost is in the extension's
// externally_connectable list, so the pages can talk to it. Run: pnpm fe
//   /         fe/index.html    the reference front end
//   /website  fe/website.html  the v4 website (the Start button runs Spyne Report Helper)
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const PORT = 8790;
const PAGES = { '/': 'index.html', '/website': 'website.html' };
createServer((req, res) => {
  const file = PAGES[new URL(req.url ?? '/', 'http://localhost').pathname];
  if (!file) return res.writeHead(404).end('not found');
  res.writeHead(200, { 'content-type': 'text/html' }).end(readFileSync(new URL(`../fe/${file}`, import.meta.url)));
}).listen(PORT, '127.0.0.1', () => console.log(`Spyne Report Helper demo front end on http://localhost:${PORT}`));
