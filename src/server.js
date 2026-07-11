// scout serve — a zero-dependency HTTP server exposing the reading cache for
// the web "reading room": the library, full-text search, and a single article.
// Node's built-in http only. Read-only and cache-only — it never hits the network.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { library, search, page, related, stats, overview, fetchUrl, pageLinks } from './core.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dir, '..', 'public');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

// Endpoints only read the cache; /api/page returns 404 for anything not read yet.
// Where cortex's web view lives, so an article can be kept in the brain.
// scout never writes to it — the browser POSTs to cortex's own /api/capture.
// This is the original `scout fetch | cortex capture` loop, in one click.
const CORTEX_URL = (process.env.SCOUT_CORTEX_URL || 'http://localhost:7800').replace(/\/$/, '');

const api = {
  '/api/stats': () => ({ ...stats(), cortex: CORTEX_URL }),
  '/api/library': () => library({ k: 2000 }),
  '/api/overview': (q) => overview({ top: q.top ? +q.top : 8 }),
  '/api/search': (q) => search(q.q || '', { k: q.k ? +q.k : 20, max_tokens: q.tokens ? +q.tokens : 4000 }),
  '/api/page': (q) => {
    const p = q.url && page(q.url);
    if (!p) throw new Error('not in cache');
    return p;
  },
  // where a cached page points — from the cache, no network
  '/api/links': (q) => {
    const l = pageLinks(q.url || '', { limit: q.limit });
    if (!l) throw new Error('not in cache');
    return l;
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

// Read a JSON body (a url is small — cap it hard).
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '', size = 0;
    req.on('data', (c) => { size += c.length; if (size > 8192) { reject(new Error('body too large')); req.destroy(); } else d += c; });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { reject(new Error('invalid JSON body')); } });
    req.on('error', reject);
  });
}

export function createScoutServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      return res.end();
    }

    // Read a page into the library. The rest of this server is read-only over the
    // cache; this is the one thing that reaches the network and writes — so it is a
    // POST. A GET must never be able to make the server fetch a URL for you.
    if (url.pathname === '/api/fetch') {
      if (req.method !== 'POST') return json(res, 405, { error: 'use POST' });
      try {
        const body = await readBody(req);
        const target = String(body.url || '').trim();
        if (!target) return json(res, 400, { error: 'url is required' });
        // only the web — no file:, data:, or anything else that isn't a page
        const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(target);
        if (scheme && !/^https?$/i.test(scheme[1])) return json(res, 400, { error: 'only http(s) urls can be read' });
        const p = await fetchUrl(target, { fresh: body.fresh === true });
        return json(res, 200, p);
      } catch (e) { return json(res, 502, { error: String(e.message || e) }); }
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
