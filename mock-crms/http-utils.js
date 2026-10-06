import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function html(res, body, status = 200, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
}

export function json(res, data, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function redirect(res, location, headers = {}) {
  res.writeHead(302, { location, ...headers });
  res.end();
}

export const notFound = (res) => html(res, '<h1>Not found</h1>', 404);

export function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .map((part) => part.trim().split('='))
      .filter(([key]) => key)
      .map(([key, ...rest]) => [key, decodeURIComponent(rest.join('='))]),
  );
}

export function readForm(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(body))));
  });
}

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const TYPES = { '.js': 'text/javascript', '.css': 'text/css' };

// Serves /assets/<file> from mock-crms/public.
export async function serveAsset(res, pathname) {
  const file = normalize(join(PUBLIC_DIR, pathname.slice('/assets/'.length)));
  if (!file.startsWith(PUBLIC_DIR) || !TYPES[extname(file)]) return notFound(res);
  try {
    res.writeHead(200, { 'content-type': TYPES[extname(file)] });
    res.end(await readFile(file));
  } catch {
    notFound(res);
  }
}
