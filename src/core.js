// scout core — the agent's window to the web. Fetch a URL, extract clean
// readable markdown, cache it (so re-reads cost nothing), and search everything
// you've ever read. Token-budgeted, like lens/cortex — pointed at the web.
import { db, get, all, run, DB_PATH } from './db.js';
import { htmlToMarkdown, extractTitle, extractDescription, extractLinks } from './extract.js';

const estTokens = (s) => Math.ceil((s || '').length / 4);
const nowISO = () => new Date().toISOString();
const normUrl = (u) => { let s = String(u || '').trim(); if (!/^https?:\/\//i.test(s)) s = 'https://' + s; return s; };

async function httpGet(url, timeout) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'scout/0.1 (+github.com/tools-for-agents)', accept: 'text/html,application/xhtml+xml,*/*' },
    signal: AbortSignal.timeout(timeout),
  });
  return { status: res.status, finalUrl: res.url || url, contentType: res.headers.get('content-type') || '', text: await res.text() };
}

function shape(row, max_tokens, fromCache) {
  let md = row.markdown || '';
  let truncated = false;
  if (max_tokens && estTokens(md) > max_tokens) {
    md = md.slice(0, max_tokens * 4) + '\n\n…[truncated — raise max_tokens, or use scout_search to find within this page]';
    truncated = true;
  }
  return { url: row.url, final_url: row.final_url, title: row.title, description: row.description,
    status: row.status, from_cache: fromCache, fetched_at: row.fetched_at,
    html_bytes: row.html_bytes, md_bytes: row.md_bytes, tokens: estTokens(md), truncated, markdown: md };
}

const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; } };

// Persist a page into the cache + FTS index. Shared by fetchUrl and the seed.
export function save({ url, final_url, title, description = '', markdown = '', content_type = 'text/html',
  status = 200, html_bytes, md_bytes, fetched_at } = {}) {
  url = normUrl(url);
  final_url = final_url || url;
  html_bytes = html_bytes ?? markdown.length;
  md_bytes = md_bytes ?? markdown.length;
  run(`INSERT INTO pages (url,final_url,title,description,markdown,content_type,status,html_bytes,md_bytes,fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(url) DO UPDATE SET final_url=excluded.final_url, title=excluded.title,
         description=excluded.description, markdown=excluded.markdown, content_type=excluded.content_type,
         status=excluded.status, html_bytes=excluded.html_bytes, md_bytes=excluded.md_bytes, fetched_at=excluded.fetched_at`,
    url, final_url, title, description, markdown, content_type, status, html_bytes, md_bytes, fetched_at || nowISO());
  run('DELETE FROM pages_fts WHERE url=?', url);
  run('INSERT INTO pages_fts (url,title,markdown) VALUES (?,?,?)', url, title, markdown);
  return get('SELECT * FROM pages WHERE url=?', url);
}

// ── fetch a URL → clean markdown (read-through cache) ──────────────────────────
export async function fetchUrl(url, { fresh = false, max_tokens = 6000, raw = false, timeout = 20000 } = {}) {
  url = normUrl(url);
  const cached = get('SELECT * FROM pages WHERE url=?', url);
  if (cached && !fresh) return shape(cached, max_tokens, true);

  const r = await httpGet(url, timeout);
  const isHtml = /html|xml/i.test(r.contentType) || /^\s*<(?:!doctype|html)/i.test(r.text);
  const title = isHtml ? (extractTitle(r.text) || url) : url;
  const description = isHtml ? extractDescription(r.text) : '';
  const markdown = raw || !isHtml ? r.text : htmlToMarkdown(r.text, r.finalUrl);

  save({ url, final_url: r.finalUrl, title, description, markdown, content_type: r.contentType,
    status: r.status, html_bytes: r.text.length, md_bytes: markdown.length });
  return shape(get('SELECT * FROM pages WHERE url=?', url), max_tokens, false);
}

// ── read-only "reading room" views (serve the cache; never hit the network) ────
export function library({ k = 1000 } = {}) {
  const pages = all(`SELECT url, final_url, title, description, status, html_bytes, md_bytes, fetched_at
                     FROM pages ORDER BY fetched_at DESC LIMIT ?`, k)
    .map((p) => ({ ...p, host: hostOf(p.final_url || p.url), tokens: Math.ceil((p.md_bytes || 0) / 4) }));
  return { count: pages.length, pages };
}

export function page(url) {
  url = normUrl(url);
  const row = get('SELECT * FROM pages WHERE url=?', url);
  if (!row) return null;
  return { ...shape(row, 0, true), host: hostOf(row.final_url || row.url) };
}

// ── search everything you've read (FTS5 + bm25, token-budgeted snippets) ──────
function ftsQuery(q) {
  const terms = String(q).match(/[A-Za-z0-9_]+/g) || [];
  return terms.length ? terms.map((t) => `"${t}"`).join(' OR ') : null;
}

export function search(query, { k = 8, max_tokens = 1800 } = {}) {
  // Harden numeric args: a non-numeric query param arrives as NaN (the server
  // parses ?k=abc with +q.k), and NaN bypasses the destructuring default. Left
  // unguarded it breaks the SQL `LIMIT ?` bind (→ error result), and both
  // `results.length >= NaN` and the budget check `tokens + tk > NaN` are always
  // false, so the search over-returns. Fall back to the default on NaN / ≤0.
  k = Number.isFinite(+k) && +k > 0 ? Math.floor(+k) : 8;
  max_tokens = Number.isFinite(+max_tokens) && +max_tokens > 0 ? Math.floor(+max_tokens) : 1800;
  const m = ftsQuery(query);
  if (!m) return { query, count: 0, tokens: 0, results: [] };
  let rows;
  try {
    rows = all(`SELECT p.url, p.title, snippet(pages_fts, 2, '⟦', '⟧', ' … ', 18) AS snip, bm25(pages_fts) AS score
                FROM pages_fts JOIN pages p ON p.url = pages_fts.url
                WHERE pages_fts MATCH ? ORDER BY score LIMIT ?`, m, Math.max(k * 3, 20));
  } catch (e) { return { query, error: e.message, results: [] }; }

  const results = [];
  let tokens = 0;
  for (const r of rows) {
    if (results.length >= k) break;
    const excerpt = (r.snip || '').replace(/\s+/g, ' ').trim();
    const tk = estTokens(excerpt);
    if (tokens + tk > max_tokens && results.length > 0) continue;
    results.push({ url: r.url, title: r.title, score: Math.round(r.score * 1000) / 1000, tokens: tk, excerpt });
    tokens += tk;
  }
  return { query, count: results.length, tokens, results };
}

// ── links: outbound links from a page (fetches + caches it if needed) ─────────
export async function links(url, { limit = 100 } = {}) {
  url = normUrl(url);
  const r = await httpGet(url, 20000);
  const found = extractLinks(r.text, r.finalUrl, limit);
  return { url, final_url: r.finalUrl, count: found.length, links: found };
}

export function list({ k = 25 } = {}) {
  return { pages: all(`SELECT url, title, md_bytes, fetched_at FROM pages ORDER BY fetched_at DESC LIMIT ?`, k) };
}

export function forget(url) {
  url = normUrl(url);
  const n = get('SELECT COUNT(*) n FROM pages WHERE url=?', url).n;
  run('DELETE FROM pages WHERE url=?', url);
  run('DELETE FROM pages_fts WHERE url=?', url);
  return { url, forgotten: n > 0 };
}

export function stats() {
  return {
    cache: DB_PATH,
    pages: get('SELECT COUNT(*) n FROM pages').n,
    total_md_bytes: get('SELECT COALESCE(SUM(md_bytes),0) n FROM pages').n,
    total_html_bytes: get('SELECT COALESCE(SUM(html_bytes),0) n FROM pages').n,
    last_fetched: get('SELECT MAX(fetched_at) m FROM pages').m,
  };
}
