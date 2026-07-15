// scout core — the agent's window to the web. Fetch a URL, extract clean
// readable markdown, cache it (so re-reads cost nothing), and search everything
// you've ever read. Token-budgeted, like lens/cortex — pointed at the web.
import { get, all, run, DB_PATH, storeExists, atomically } from './db.js';
import { htmlToMarkdown, extractTitle, extractDescription, extractLinks } from './extract.js';

const estTokens = (s) => Math.ceil((s || '').length / 4);
const nowISO = () => new Date().toISOString();
// The day a page was read, in the reader's LOCAL timezone. `fetched_at` is a UTC timestamp, so
// slicing its first 10 chars bucketed a late-night read onto the wrong calendar day for anyone not
// on UTC. The reading overview is a personal "what did I read today", so the day is local.
const localDay = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? '' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// Coerce a count/limit that arrived NaN ('?k=abc'), a string, 0, negative or Infinity to a sane bound.
// Raw, a bad value THROWS at the SQLite `LIMIT ?` bind ("datatype mismatch"), makes `LIMIT -1` return
// the WHOLE table, or makes extractLinks' `out.length < NaN` return nothing — all silent-wrong answers.
const posInt = (v, def, max) => (Number.isFinite(+v) && +v > 0 ? Math.min(Math.floor(+v), max) : def);
// Strip the #fragment: it is CLIENT-SIDE ONLY — never sent to the server — so `page#a` and `page#b`
// are the exact same fetched resource. Keeping it in the cache key defeated the cache (each section
// deep-link re-fetched the whole page) and listed one article as many rows in the reading room. A
// literal '#' in a path/query is percent-encoded (%23), so only the real fragment is removed.
const normUrl = (u) => { let s = String(u || '').trim(); if (!/^https?:\/\//i.test(s)) s = 'https://' + s; return s.replace(/#.*$/, ''); };

// `fetch failed` / `terminated`. That is the whole message Node gives you, and it is the whole
// message an agent used to get: a word that names no cause, suggests no action, and cannot be told
// apart from a typo, a dead host, a DNS failure, or no network at all. Its next move is to guess. An
// error an agent cannot act on is an error you have not finished writing — so say WHICH it was.
function fetchError(url, timeout, e) {
  const code = e.cause?.code || e.code || '';
  const causeMsg = e.cause?.message || '';
  const why = {
    ENOTFOUND: 'no such host — check the domain, or you may be offline',
    EAI_AGAIN: 'DNS lookup failed — you may be offline',
    ECONNREFUSED: 'the host refused the connection — nothing is listening there',
    ECONNRESET: 'the host closed the connection',
    // 🔑 UND_ERR_SOCKET is `terminated`: the socket closed WHILE the body was still downloading.
    // Raw, an agent sees only "terminated" — and worse, it used to bypass this whole mapper because
    // the body was read OUTSIDE the try/catch (see below). The page you got is INCOMPLETE, which is
    // the one thing the caller must know before it reasons about half a document.
    UND_ERR_SOCKET: 'the connection dropped before the page finished downloading — the response is incomplete; try again',
    CERT_HAS_EXPIRED: "the site's TLS certificate has expired",
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: "the site's TLS certificate could not be verified",
  }[code] || (e.name === 'TimeoutError' || /abort/i.test(e.name)
    ? `no response within ${timeout}ms`
    // fetch FOLLOWS redirects, but stops after ~20 hops and throws. The raw cause is undici's
    // internal "redirect count exceeded" — whose exact wording has drifted across Node versions,
    // so scout only read it because that phrase happens to be English (the Cycle-95 fragility, one
    // redirect over). Name it deliberately, and say it is TERMINAL: a loop (A→B→A) or an over-long
    // chain does the same thing on a retry, so an agent must not just try the same URL again.
    : (/redirect count exceeded|too many redirect|maximum redirect|redirected too many/i.test(causeMsg)
      ? 'this URL redirects too many times — likely a redirect loop or a broken redirect chain; the page cannot be reached, and retrying the same URL will not help'
      : (/terminated/i.test(e.message) ? 'the connection dropped before the page finished downloading — the response is incomplete; try again'
        : (e.cause?.message || e.message || 'the request failed'))));
  return new Error(`could not fetch ${url} — ${why}${code ? ` (${code})` : ''}`);
}

// The character encoding the server declared, e.g. "text/html; charset=Shift_JIS" → "shift_jis".
// A page decoded in the wrong charset is mojibake for every non-ASCII byte, and the header is the
// authoritative place the encoding is stated. Absent → null (readCapped falls back to UTF-8).
const charsetOf = (contentType) => (/charset\s*=\s*["']?([\w:.-]+)/i.exec(contentType || '')?.[1] || '').toLowerCase() || null;

async function httpGet(url, timeout) {
  // The body read is INSIDE the try, on purpose. It used to be outside — so a connection that dropped
  // mid-download threw a bare "terminated" that skipped fetchError entirely, undoing the whole point
  // of naming fetch failures. A response is not received until its body is; the failure window covers
  // both.
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'scout/0.1 (+github.com/tools-for-agents)', accept: 'text/html,application/xhtml+xml,*/*' },
      signal: AbortSignal.timeout(timeout),
    });
    const contentType = res.headers.get('content-type') || '';
    const body = await readCapped(res, charsetOf(contentType));
    return { status: res.status, finalUrl: res.url || url, contentType, ...body };
  } catch (e) {
    throw fetchError(url, timeout, e);
  }
}

// The most a single page may pour into memory and the cache. `res.text()` buffers the WHOLE
// response unconditionally — so a 500MB page (a log dump, a runaway endpoint, a hostile server)
// would spike the agent's memory and bloat the SQLite cache + FTS index with it. Stream instead,
// stop at the cap, and TELL the caller we stopped (never a silent truncation). A web page gets
// more room than a source file — lens caps those at 1.5MB. Tunable via SCOUT_MAX_BYTES.
const maxBytes = () => Math.max(1, +process.env.SCOUT_MAX_BYTES || 5_000_000);

// SQLite's snippet() is superlinear in the size of the document it excerpts: 3ms on a 16KB page,
// 792ms at 256KB, and 142 SECONDS at 4MB — while the MATCH that found the row costs 1ms. So ONE
// oversized page hangs every search whose term it contains: no error, no answer, just a dead call.
//
// 🔑 AND THE CAP ABOVE DOES NOT SAVE US — IT IS WHAT LETS IT IN. maxBytes() says a 5MB page is
// perfectly legal to fetch and cache. snippet() says 4MB takes 142 seconds. The two limits were
// each chosen sensibly, on their own, and NOBODY EVER ASKED THEM ABOUT EACH OTHER: scout's own cap
// admits exactly the page that hangs scout's own search. A limit is not a guarantee about anything
// downstream of it.
//
// CASE short-circuits in SQLite, so snippet() is never evaluated past this bound. instr() is a plain
// C scan (2ms on the same 4MB body), so an oversized page still gets a REAL window around a REAL
// match; where the porter tokenizer matched by stem and no literal window exists, the hit says so
// rather than pass its head off as the matching passage.
const SNIPPET_MAX = 64 * 1024; // bounds snippet() at ~30ms worst case; every real page is far below
// A byte-order mark is a DEFINITIVE encoding declaration — it outranks anything the markup says.
const bomCharset = (buf) => (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) ? 'utf-8'
  : (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) ? 'utf-16le'
    : (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) ? 'utf-16be' : null;

// Many legacy/regional pages declare their encoding ONLY in the markup, not the HTTP header:
// <meta charset="shift_jis"> or the old <meta http-equiv="Content-Type" content="…; charset=…">.
// Scan the first bytes as latin1 (every byte maps, so the scan itself can never be mojibake) for it.
// The HTML spec caps this pre-scan at 1024 bytes; 2KB is slack for a fat <head>.
const metaCharset = (buf) => {
  const head = Buffer.from(buf.subarray(0, 2048)).toString('latin1');
  return /<meta[^>]+charset\s*=\s*["']?\s*([\w:.-]+)/i.exec(head)?.[1]?.toLowerCase() || null;
};

async function readCapped(res, headerCharset) {
  if (!res.body) return { text: await res.text(), capped: false };
  const cap = maxBytes();
  const reader = res.body.getReader();
  // Buffer the (capped) bytes, THEN decode — because the charset can be declared INSIDE the document
  // (a <meta> or a BOM), which streaming-decode-as-you-go cannot see until it is too late. Memory is
  // still bounded by the cap; the old form held the whole decoded string anyway.
  const chunks = [];
  let bytes = 0, capped = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    bytes += value.byteLength;
    if (bytes >= cap) { capped = true; await reader.cancel(); break; }
  }
  let buf = Buffer.concat(chunks);
  if (buf.length > cap) buf = buf.subarray(0, cap);
  // Charset precedence, the HTML sniffing order simplified: the HTTP header (authoritative) wins, then
  // a BOM, then a <meta> in the head, then UTF-8. An UNKNOWN label makes `new TextDecoder(label)`
  // THROW, so a weird/typo'd charset degrades to UTF-8 and never crashes the fetch. TextDecoder is
  // non-fatal by default (a bad byte → U+FFFD) — one bad byte must not sink the whole page.
  const charset = headerCharset || bomCharset(buf) || metaCharset(buf) || 'utf-8';
  let dec;
  try { dec = new TextDecoder(charset); } catch { dec = new TextDecoder('utf-8'); }
  return { text: dec.decode(buf), capped };
}

function shape(row, max_tokens, fromCache) {
  let md = row.markdown || '';
  let truncated = false;
  if (max_tokens && estTokens(md) > max_tokens) {
    md = md.slice(0, max_tokens * 4) + '\n\n…[truncated — raise max_tokens, or use scout_search to find within this page]';
    truncated = true;
  }
  return { url: row.url, final_url: row.final_url, title: row.title, description: row.description,
    status: row.status, content_type: row.content_type, from_cache: fromCache, fetched_at: row.fetched_at,
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
  // The page row and its FTS entry must land TOGETHER — apart, a search landing between the DELETE
  // and the INSERT sees this page with NO FTS row, and scout answers "0 hits across your reading"
  // about a page that is right there in the cache. (See `atomically` in db.js.)
  atomically(() => {
    run(`INSERT INTO pages (url,final_url,title,description,markdown,content_type,status,html_bytes,md_bytes,fetched_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(url) DO UPDATE SET final_url=excluded.final_url, title=excluded.title,
           description=excluded.description, markdown=excluded.markdown, content_type=excluded.content_type,
           status=excluded.status, html_bytes=excluded.html_bytes, md_bytes=excluded.md_bytes, fetched_at=excluded.fetched_at`,
      url, final_url, title, description, markdown, content_type, status, html_bytes, md_bytes, fetched_at || nowISO());
    run('DELETE FROM pages_fts WHERE url=?', url);
    run('INSERT INTO pages_fts (url,title,markdown) VALUES (?,?,?)', url, title, markdown);
  });
  return get('SELECT * FROM pages WHERE url=?', url);
}

// ── fetch a URL → clean markdown (read-through cache) ──────────────────────────
// A binary resource (PDF, image, archive, font) decoded as UTF-8 text is mojibake.
// `res.text()` never fails — it just fills the string with replacement characters — so
// without this, `scout_fetch` on a PDF handed the agent a blob of garbage that read like a
// successful page, and poisoned the cache and FTS index with it. Catch it by content-type,
// or by a body that decoded into mostly replacement/control bytes (a header can be wrong or
// missing). `raw` deliberately bypasses this — that mode is "give me the bytes as-is".
function looksBinary(contentType, text) {
  if (/^(image|audio|video|font)\//i.test(contentType)) return true;
  if (/\b(pdf|zip|gzip|octet-stream|msword|ms-excel|ms-powerpoint|x-tar|x-7z|x-rar|wasm|ttf|otf|woff2?)\b/i.test(contentType)) return true;
  const sample = (text || '').slice(0, 4000);
  if (!sample) return false;
  let bad = 0;
  for (const ch of sample) {
    const c = ch.codePointAt(0);
    if (c === 0xFFFD || c === 0 || (c > 0 && c < 9) || (c > 13 && c < 32)) bad++;   // NUL / C0 controls (not tab/LF/CR) / replacement
  }
  return bad / sample.length > 0.1;
}

export async function fetchUrl(url, { fresh = false, max_tokens = 6000, raw = false, timeout = 20000 } = {}) {
  url = normUrl(url);
  const cached = get('SELECT * FROM pages WHERE url=?', url);
  if (cached && !fresh) return shape(cached, max_tokens, true);

  const r = await httpGet(url, timeout);
  const binary = !raw && looksBinary(r.contentType, r.text);
  const isHtml = !binary && (/html|xml/i.test(r.contentType) || /^\s*<(?:!doctype|html)/i.test(r.text));
  const title = binary ? `[binary: ${r.contentType || 'unknown type'}]`
    : (isHtml ? (extractTitle(r.text) || url) : url);
  const description = isHtml ? extractDescription(r.text) : '';
  let markdown = binary
    ? `scout fetched a binary resource (${r.contentType || 'unknown content-type'}) from ${url}. `
      + `scout turns HTML and text into readable markdown; it cannot render a binary file — an image, PDF, `
      + `archive, or font — as text. Use a tool built for that content type.`
    : (raw || !isHtml ? r.text : htmlToMarkdown(r.text, r.finalUrl));
  // The cap is not the same as shape()'s token truncation: the rest of the page was NEVER FETCHED,
  // so raising max_tokens won't get it. Lead with the note so it survives the token-budget cut.
  if (r.capped && !binary) {
    const cap = maxBytes();
    const size = cap >= 1e6 ? `${Math.round(cap / 1e5) / 10}MB` : `${Math.round(cap / 1000)}KB`;
    markdown = `> [scout read only the first ${size} of this oversized page — the rest was not fetched. `
      + `What follows is the beginning; use scout_search to find within it.]\n\n${markdown}`;
  }
  // A 4xx/5xx still has a BODY — usually a friendly HTML error page ("Oops, not found — try
  // our homepage") — and scout will happily convert it to clean markdown. Handed back
  // unqualified, an agent reads the error page's prose as if it were the article it asked for:
  // a confident wrong answer, with only the sibling `status` field to say otherwise. Lead with
  // the truth so it survives the token cut and cannot be missed (the same move as the binary
  // and oversized notes). scout ANNOTATES rather than refuses — the body stays available for
  // anyone debugging the error itself.
  if (r.status >= 400) {
    const reason = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
      408: 'Request Timeout', 410: 'Gone', 429: 'Too Many Requests', 500: 'Internal Server Error',
      502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' }[r.status] || 'error';
    markdown = `> [scout got HTTP ${r.status} ${reason} from ${url} — this is the server's ERROR page, `
      + `NOT the content you asked for. Do not treat the text below as the page's real content.]\n\n${markdown}`;
  }

  save({ url, final_url: r.finalUrl, title, description, markdown, content_type: r.contentType,
    status: r.status, html_bytes: r.text.length, md_bytes: markdown.length });
  return shape(get('SELECT * FROM pages WHERE url=?', url), max_tokens, false);
}

// ── read-only "reading room" views (serve the cache; never hit the network) ────
export function library({ k = 1000 } = {}) {
  k = posInt(k, 1000, 10000);
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
  // \p{L}\p{N} (not [A-Za-z0-9]) so a query in any script — Turkish, Cyrillic, CJK —
  // tokenizes the SAME way unicode61 indexed the pages; ASCII-only stripped every
  // non-Latin term to nothing and searched for a ghost.
  const terms = String(q).match(/[\p{L}\p{N}_]+/gu) || [];
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
  try { return get(`SELECT COUNT(*) n FROM pages`)?.n ?? 0; } catch { return 0; }
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
  const probe = (String(query).match(/[\p{L}\p{N}_]+/gu) || [''])[0];
  let rows;
  try {
    rows = all(`SELECT p.url, p.title, length(pages_fts.markdown) AS chars,
                  CASE WHEN length(pages_fts.markdown) <= ?
                       THEN snippet(pages_fts, 2, '⟦', '⟧', ' … ', 18)
                       ELSE substr(pages_fts.markdown,
                              MAX(1, instr(lower(pages_fts.markdown), lower(?)) - 90), 240) END AS snip,
                  CASE WHEN length(pages_fts.markdown) <= ? THEN 1
                       ELSE instr(lower(pages_fts.markdown), lower(?)) > 0 END AS located,
                  bm25(pages_fts) AS score
                FROM pages_fts JOIN pages p ON p.url = pages_fts.url
                WHERE pages_fts MATCH ? ORDER BY score LIMIT ?`,
      SNIPPET_MAX, probe, SNIPPET_MAX, probe, m, Math.max(k * 3, 20));
  } catch (e) { return { query, error: e.message, results: [] }; }

  const results = [];
  let tokens = 0, squeezed = 0;
  for (const r of rows) {
    if (results.length >= k) break;
    const excerpt = (r.snip || '').replace(/\s+/g, ' ').trim();
    const tk = estTokens(excerpt);
    if (tokens + tk > max_tokens && results.length > 0) { squeezed++; continue; }
    const hit = { url: r.url, title: r.title, score: Math.round(r.score * 1000) / 1000, tokens: tk, excerpt };
    // Say so, rather than let the caller take this for the usual best-matching window.
    if (r.chars > SNIPPET_MAX) { hit.oversized = true; hit.chars = r.chars; hit.excerpt_is_match = !!r.located; }
    results.push(hit);
    tokens += tk;
  }

  // How many pages actually matched — not how many survived the budget/k. Without this a
  // caller cannot tell "6 pages exist" from "6 of 40 fit the budget", and a budget that hides
  // results while claiming to be complete is worse than no budget (same contract as lens).
  let matched = results.length;
  try { matched = get(`SELECT COUNT(*) n FROM pages_fts WHERE pages_fts MATCH ?`, m)?.n ?? results.length; }
  catch { /* keep the floor */ }
  const withheld = Math.max(0, matched - results.length);
  const limited_by = withheld === 0 ? null : squeezed > 0 ? 'budget' : 'k';
  return { query, searched, count: results.length, tokens, results, matched, withheld, limited_by, budget: max_tokens, k };
}

// ── links: outbound links from a page (fetches + caches it if needed) ─────────
export async function links(url, { limit = 100 } = {}) {
  limit = posInt(limit, 100, 2000);
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
  k = posInt(k, 25, 1000);
  return { pages: all(`SELECT url, title, md_bytes, fetched_at FROM pages ORDER BY fetched_at DESC LIMIT ?`, k) };
}

// Re-read a page you already have. A cache is only worth trusting if you can ask
// it again — otherwise what you read a month ago is what you will always read. And
// the answer that matters is not "here it is again" but **did it change** since you
// read it: a page that hasn't moved means your notes are still good.
const mdLines = (s) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean);
export function pageDiff(before, after) {
  const a = mdLines(before), b = mdLines(after);
  // Count added/removed as MULTISET differences, not set membership. A Set ignores HOW MANY times a line
  // occurs, so a change that only alters a line's count — a duplicate entry added to a status page, one of
  // two identical rows removed, an "a" line turning into a "b" line — left both sets unchanged, and reread
  // reported "no change" (added:0, removed:0) for a page that DID change. reread's one job is to answer
  // "did this move on before I trust my cached copy?"; the set-based diff answered it wrong exactly when
  // repeated lines are in play (list items, boilerplate, "Operational" status rows), which is common.
  const count = (lines) => { const m = new Map(); for (const l of lines) m.set(l, (m.get(l) || 0) + 1); return m; };
  const ca = count(a), cb = count(b);
  let added = 0, removed = 0;
  for (const [l, n] of cb) added += Math.max(0, n - (ca.get(l) || 0));
  for (const [l, n] of ca) removed += Math.max(0, n - (cb.get(l) || 0));
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
  // A read never creates the store (Cycle: stop the tools littering every directory they are asked a
  // question in). forget is a WRITE, but forgetting a URL that was never cached — on a machine with no
  // cache at all — must not litter a .scout/ into existence just to delete nothing. `get()` opens
  // READ-ONLY (no create), so an uncached URL falls through here as n===0 and returns BEFORE any
  // `run()` (which opens create=true and would conjure the store). ONE guard does it; two would be
  // redundant (a canary on either survives, because the other still covers it).
  const n = get('SELECT COUNT(*) n FROM pages WHERE url=?', url)?.n ?? 0;
  if (n === 0) return { url, forgotten: false };
  // Delete the page row and its FTS row TOGETHER — the same way save() writes them (see `atomically`).
  atomically(() => {
    run('DELETE FROM pages WHERE url=?', url);
    run('DELETE FROM pages_fts WHERE url=?', url);
  });
  return { url, forgotten: true };
}

// A read no longer CREATES the store — that fix stopped the tools littering every
// directory they were asked a question in — which means `get()` returns undefined when
// there is no store yet, and `.n` on undefined is a TypeError.
//
// So `scout serve` on a machine with no cache CRASHED AT STARTUP: stats() runs before the
// server listens, so a brand-new user's very first command died. Nothing caught it: the
// tests seed, the CI gate seeds, and my machine has had a cache for weeks. The bug lived
// in a state my machine never enters — and I put it there myself, fixing something else.
export function stats() {
  return {
    cache: DB_PATH,
    pages: get('SELECT COUNT(*) n FROM pages')?.n ?? 0,
    total_md_bytes: get('SELECT COALESCE(SUM(md_bytes),0) n FROM pages')?.n ?? 0,
    total_html_bytes: get('SELECT COALESCE(SUM(html_bytes),0) n FROM pages')?.n ?? 0,
    last_fetched: get('SELECT MAX(fetched_at) m FROM pages')?.m ?? null,
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
    const d = localDay(p.fetched_at);
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
