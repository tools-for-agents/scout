// scout core — the agent's window to the web. Fetch a URL, extract clean
// readable markdown, cache it (so re-reads cost nothing), and search everything
// you've ever read. Token-budgeted, like lens/cortex — pointed at the web.
import { db, get, all, run, DB_PATH } from './db.js';
import { htmlToMarkdown, extractTitle, extractDescription, extractLinks } from './extract.js';

const estTokens = (s) => Math.ceil((s || '').length / 4);
const nowISO = () => new Date().toISOString();
const normUrl = (u) => { let s = String(u || '').trim(); if (!/^https?:\/\//i.test(s)) s = 'https://' + s; return s; };

async function httpGet(url, timeout) {
  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'scout/0.1 (+github.com/tools-for-agents)', accept: 'text/html,application/xhtml+xml,*/*' },
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    // `fetch failed`. That is the whole message Node gives you, and it is the whole
    // message an agent used to get: three words that name no cause, suggest no action,
    // and cannot be told apart from a typo, a dead host, a DNS failure, or no network at
    // all. Its next move is to guess. An error an agent cannot act on is an error you
    // have not finished writing — so say WHICH of those it was.
    const code = e.cause?.code || e.code || '';
    const why = {
      ENOTFOUND: 'no such host — check the domain, or you may be offline',
      EAI_AGAIN: 'DNS lookup failed — you may be offline',
      ECONNREFUSED: 'the host refused the connection — nothing is listening there',
      ECONNRESET: 'the host closed the connection',
      CERT_HAS_EXPIRED: "the site's TLS certificate has expired",
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: "the site's TLS certificate could not be verified",
    }[code] || (e.name === 'TimeoutError' || /abort/i.test(e.name)
      ? `no response within ${timeout}ms`
      : (e.cause?.message || e.message || 'the request failed'));
    throw new Error(`could not fetch ${url} — ${why}${code ? ` (${code})` : ''}`);
  }
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

// Other cached pages from the same host as `url` — powers "more from this site"
// in the reader. Returns an empty list (not an error) for an unknown/uncached url.
export function related(url, { k = 6 } = {}) {
  k = Number.isFinite(+k) && +k > 0 ? Math.floor(+k) : 6;
  url = normUrl(url);
  const cur = get('SELECT url, final_url FROM pages WHERE url=?', url);
  if (!cur) return { url, host: null, pages: [] };
  const host = hostOf(cur.final_url || cur.url);
  const pages = all('SELECT url, final_url, title, fetched_at, md_bytes FROM pages ORDER BY fetched_at DESC')
    .map((p) => ({ url: p.url, title: p.title, fetched_at: p.fetched_at,
      host: hostOf(p.final_url || p.url), tokens: Math.ceil((p.md_bytes || 0) / 4) }))
    .filter((p) => host && p.host === host && p.url !== url)
    .slice(0, k);
  return { url, host, pages };
}

// ── search everything you've read (FTS5 + bm25, token-budgeted snippets) ──────
function ftsQuery(q) {
  const terms = String(q).match(/[A-Za-z0-9_]+/g) || [];
  return terms.length ? terms.map((t) => `"${t}"`).join(' OR ') : null;
}


// AN EMPTY RESULT MUST CARRY THE SIZE OF THE HAYSTACK.
//
// "0 hits" and "0 hits, out of 0 things I have ever seen" are the same sentence to a
// caller, and they mean opposite things. Opening a missing store CREATES it, so a search
// against a vault/cache that does not exist answered, confidently: "— 0 hits —". An agent
// asking "what do I know about X" was told NOTHING, when the truth was there is nothing
// here to know it FROM. It believes that and moves on.
//
// So say what was searched. "0 of 0 notes" makes a misconfigured path obvious at a glance;
// "0 of 500 notes" is a real answer to a real question.
function corpus() {
  try { return get(`SELECT COUNT(*) n FROM pages`).n; } catch { return 0; }
}

export function search(query, { k = 8, max_tokens = 1800 } = {}) {
  const searched = { pages: corpus(), cache: DB_PATH };
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
  return { query, searched, count: results.length, tokens, results };
}

// ── links: outbound links from a page (fetches + caches it if needed) ─────────
export async function links(url, { limit = 100 } = {}) {
  url = normUrl(url);
  const r = await httpGet(url, 20000);
  const found = extractLinks(r.text, r.finalUrl, limit);
  return { url, final_url: r.finalUrl, count: found.length, links: found };
}

// Where a page you've already read points — answered from the CACHE, no network
// trip: the clean markdown scout kept still carries the page's links. Each one says
// whether it is already in your library, so the reading room can show you the edge
// of what you've read and let you step over it.
export function pageLinks(url, { limit = 60 } = {}) {
  limit = Number.isFinite(+limit) && +limit > 0 ? Math.min(Math.floor(+limit), 500) : 60;
  url = normUrl(url);
  const row = get('SELECT url, final_url, markdown FROM pages WHERE url=?', url);
  if (!row) return null;                                  // cache-only, like page()

  const seen = new Set(), out = [];
  const re = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
  const self = new Set([row.url, row.final_url].filter(Boolean));
  let m;
  while ((m = re.exec(row.markdown || '')) && out.length < limit) {
    const href = m[2].replace(/[.,;:]+$/, '');            // trailing punctuation isn't part of a url
    if (seen.has(href) || self.has(href)) continue;       // a page pointing at itself is not a lead
    seen.add(href);
    const cached = get('SELECT title FROM pages WHERE url=? OR final_url=?', href, href);
    out.push({
      href,
      text: (m[1] || '').replace(/\*\*/g, '').trim() || hostOf(href),
      host: hostOf(href),
      in_library: !!cached,                               // already read → open it; not → one click to read it
      title: cached ? cached.title : null,
    });
  }
  return { url: row.url, count: out.length, links: out };
}

export function list({ k = 25 } = {}) {
  return { pages: all(`SELECT url, title, md_bytes, fetched_at FROM pages ORDER BY fetched_at DESC LIMIT ?`, k) };
}

// Re-read a page you already have. A cache is only worth trusting if you can ask
// it again — otherwise what you read a month ago is what you will always read. And
// the answer that matters is not "here it is again" but **did it change** since you
// read it: a page that hasn't moved means your notes are still good.
const mdLines = (s) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean);
export function pageDiff(before, after) {
  const a = mdLines(before), b = mdLines(after);
  const setA = new Set(a), setB = new Set(b);
  const added = b.filter((l) => !setA.has(l)).length;
  const removed = a.filter((l) => !setB.has(l)).length;
  return { changed: added > 0 || removed > 0, added, removed, was_lines: a.length, now_lines: b.length };
}

export async function reread(url, { timeout = 20000 } = {}) {
  url = normUrl(url);
  const prev = get('SELECT markdown, fetched_at, md_bytes FROM pages WHERE url=?', url);
  if (!prev) return null;                                  // you cannot re-read what you never read
  const fresh = await fetchUrl(url, { fresh: true, timeout, max_tokens: 0 });
  const diff = pageDiff(prev.markdown, fresh.markdown);
  return {
    ...fresh,
    previously_read: prev.fetched_at,
    diff,
    was_tokens: Math.ceil((prev.md_bytes || 0) / 4),
  };
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

// What the reading history adds up to. The headline is in TOKENS, not bytes:
// scout's whole point is that an agent pays for raw HTML by the token, and the
// markdown it keeps costs a fraction of it. Bytes/4 is the same estimate the rest
// of the toolkit budgets with.
const tok = (bytes) => Math.ceil((bytes || 0) / 4);
export function overview({ top = 8 } = {}) {
  // coerce at the core (?top=abc arrives as NaN → slice(0,NaN) would empty every list)
  top = Number.isFinite(+top) && +top > 0 ? Math.min(Math.floor(+top), 100) : 8;
  const pages = all(`SELECT url, final_url, title, html_bytes, md_bytes, fetched_at FROM pages`);
  const html_tokens = pages.reduce((a, p) => a + tok(p.html_bytes), 0);
  const md_tokens = pages.reduce((a, p) => a + tok(p.md_bytes), 0);
  const saved_tokens = Math.max(0, html_tokens - md_tokens);

  const hosts = {};
  for (const p of pages) {
    const h = hostOf(p.final_url || p.url) || 'web';
    (hosts[h] ||= { host: h, pages: 0, tokens: 0 });
    hosts[h].pages++; hosts[h].tokens += tok(p.md_bytes);
  }
  const by_host = Object.values(hosts).sort((a, b) => b.pages - a.pages || b.tokens - a.tokens).slice(0, top);

  const days = {};
  for (const p of pages) {
    const d = (p.fetched_at || '').slice(0, 10);
    if (d) days[d] = (days[d] || 0) + 1;
  }
  const by_day = Object.entries(days).sort(([a], [b]) => a < b ? -1 : 1).map(([day, n]) => ({ day, pages: n }));

  const heaviest = pages
    .map((p) => ({ url: p.url, title: p.title || p.url, host: hostOf(p.final_url || p.url) || 'web',
      tokens: tok(p.md_bytes), html_tokens: tok(p.html_bytes) }))
    .sort((a, b) => b.html_tokens - a.html_tokens).slice(0, top);

  return {
    pages: pages.length,
    html_tokens, md_tokens, saved_tokens,
    saved_pct: html_tokens ? Math.round(saved_tokens / html_tokens * 100) : 0,
    by_host, by_day, heaviest,
  };
}
