// scout serve — a zero-dependency HTTP server exposing the reading cache for
// the web "reading room": the library, full-text search, and a single article.
// Node's built-in http only. Read-only and cache-only — it never hits the network.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { library, search, page, related, stats } from './core.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dir, '..', 'public');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

// Endpoints only read the cache; /api/page returns 404 for anything not read yet.
const api = {
  '/api/stats': () => stats(),
  '/api/library': () => library({ k: 2000 }),
  '/api/search': (q) => search(q.q || '', { k: q.k ? +q.k : 20, max_tokens: q.tokens ? +q.tokens : 4000 }),
  '/api/page': (q) => {
    const p = q.url && page(q.url);
    if (!p) throw new Error('not in cache');
    return p;
  },
  '/api/related': (q) => {
    if (!q.url) throw new Error('url required');
    return related(q.url, { k: q.k ? +q.k : 6 });
  },
  '/api/health': () => ({ ok: true, service: 'scout', ts: new Date().toISOString() }),
};

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = normalize(join(PUBLIC, rel));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    try {
      const data = await readFile(join(PUBLIC, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    } catch { res.writeHead(404); res.end('not found'); }
  }
}

export function createScoutServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS' });
      return res.end();
    }
    const handler = api[url.pathname];
    if (handler) {
      const q = Object.fromEntries(url.searchParams.entries());
      try { return json(res, 200, await handler(q)); }
      catch (e) { return json(res, e.message === 'not in cache' ? 404 : 400, { error: String(e.message || e) }); }
    }
    return serveStatic(res, url.pathname);
  });
}

export function serve({ port = process.env.SCOUT_PORT || 7950 } = {}) {
  const server = createScoutServer();
  server.listen(port, () => {
    const s = stats();
    console.log(`\n  ☞ scout reading room → http://localhost:${port}`);
    console.log(`    ${s.pages} pages · ${(s.total_md_bytes / 1024).toFixed(0)} KB of markdown cached\n`);
  });
  return server;
}
