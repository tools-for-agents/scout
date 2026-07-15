// scout serve tests — spin the read-only web server over a throwaway cache and
// exercise the reading-room endpoints. Run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const work = mkdtempSync(join(tmpdir(), 'scout-serve-'));
process.env.SCOUT_DB = join(work, 'cache.db');
process.on('exit', () => { try { rmSync(work, { recursive: true, force: true }); } catch {} });

const { save, search, related, overview } = await import('../src/core.js');
const { createScoutServer } = await import('../src/server.js');

save({ url: 'https://example.com/reconnect', title: 'WebSocket reconnect backoff',
  description: 'Exponential backoff for socket reconnects.',
  markdown: '# Reconnect\n\nUse **exponential backoff** with jitter when a websocket drops.',
  html_bytes: 4200, fetched_at: '2026-07-01T00:00:00.000Z' });

test('serve: library, search, page and the cache guard', async () => {
  const server = createScoutServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  try {
    const lib = await fetch(base + '/api/library').then((r) => r.json());
    assert.ok(lib.count >= 1, 'library lists cached pages');
    assert.equal(lib.pages[0].host, 'example.com', 'host is derived from the url');
    assert.ok(lib.pages[0].tokens > 0, 'token estimate present');

    const hits = await fetch(base + '/api/search?q=websocket%20backoff').then((r) => r.json());
    assert.ok(hits.results.some((x) => /reconnect/i.test(x.title)), 'search finds the page');

    const page = await fetch(base + '/api/page?url=' + encodeURIComponent('https://example.com/reconnect')).then((r) => r.json());
    assert.match(page.markdown, /exponential backoff/i, 'page returns the full markdown');

    const miss = await fetch(base + '/api/page?url=' + encodeURIComponent('https://never-fetched.example/x'));
    assert.equal(miss.status, 404, 'uncached url is 404 — the reading room never hits the network');
  } finally { server.close(); }
});

test('search coerces bad numeric args instead of erroring / over-returning', () => {
  for (let i = 0; i < 4; i++) {
    save({ url: `https://ex.com/sig-${i}`, title: `Signal ${i}`, description: 'x',
      markdown: `# Signal ${i}\n\nA note about the shared signal term.`,
      html_bytes: 1000, fetched_at: '2026-07-02T00:00:00.000Z' });
  }
  // a non-numeric k (NaN, e.g. from ?k=abc) used to break the `LIMIT ?` bind
  // (undefined count) or over-return (results.length >= NaN never breaks)
  const good = search('signal');
  assert.ok(typeof good.count === 'number' && good.count >= 4, 'baseline search has a count');
  for (const bad of [NaN, 0, -5, 'abc']) {
    assert.equal(search('signal', { k: bad }).count, good.count, `k=${String(bad)} recovers the default count`);
  }
  assert.ok(search('signal', { max_tokens: 'xyz' }).tokens <= 1800, 'bad max_tokens falls back to the default budget');
});

test('list/library coerce a bad count — no crash at the LIMIT bind, no dumping everything', async () => {
  const { list, library } = await import('../src/core.js');
  for (let i = 0; i < 30; i++) save({ url: `https://num.example/${i}`, title: `Num ${i}`, markdown: `body ${i}`, html_bytes: 400 });
  // default list is 25; a bad k must fall back to it, not THROW at the SQLite LIMIT bind or LIMIT −1 all 30+
  for (const bad of [NaN, -1, 0, 'abc']) {
    assert.equal(list({ k: bad }).pages.length, 25, `list k=${String(bad)} → the default 25`);
  }
  assert.doesNotThrow(() => library({ k: NaN }), 'library survives a NaN k');
});

test('search finds a page in any script — the cache is unicode61, so the query must be too', () => {
  // Pages are indexed with unicode61 (every script); a query tokenizer that kept only
  // [A-Za-z0-9] threw away Turkish/Cyrillic/CJK terms and returned nothing that was there.
  save({ url: 'https://ornek.com.tr/seyahat', title: 'İstanbul Rehberi',
    description: 'Şehir notları.', markdown: '# İstanbul\n\nAnkara ve Москва ve 日本語 üzerine notlar.',
    html_bytes: 1200, fetched_at: '2026-07-06T00:00:00.000Z' });
  for (const q of ['İstanbul', 'Москва', '日本語']) {
    assert.ok(search(q).results.some((x) => x.url === 'https://ornek.com.tr/seyahat'),
      `a ${q} query must find the page that contains it`);
  }
});

test('search owns up to what the budget/k hid — it never looks complete when it is not', () => {
  // A budget that hides pages while reporting itself complete is worse than no budget.
  for (let i = 0; i < 12; i++) {
    save({ url: `https://budget.example/${i}`, title: `Budget page ${i}`,
      markdown: `A page about the zzbudgettopic subject, number ${i}.`, html_bytes: 700 });
  }
  const capped = search('zzbudgettopic', { k: 3 });
  assert.equal(capped.count, 3, 'only k results come back');
  assert.ok(capped.matched >= 12, 'but it reports how many pages actually matched');
  assert.equal(capped.withheld, capped.matched - capped.count, 'withheld = matched − returned');
  assert.equal(capped.limited_by, 'k', 'and it names the ceiling: k');

  const squeezed = search('zzbudgettopic', { k: 20, max_tokens: 20 });
  assert.ok(squeezed.withheld > 0 && squeezed.limited_by === 'budget', 'a tiny budget names the budget');

  const roomy = search('zzbudgettopic', { k: 50 });
  assert.equal(roomy.withheld, 0, 'nothing hidden → nothing withheld');
  assert.equal(roomy.limited_by, null, 'and it does not cry wolf');
});

test('related surfaces other cached pages from the same host', () => {
  for (let i = 0; i < 3; i++) {
    save({ url: `https://blog.example.org/post-${i}`, title: `Post ${i}`, description: 'x',
      markdown: `# Post ${i}\n\nbody`, html_bytes: 900, fetched_at: `2026-07-0${i + 1}T00:00:00.000Z` });
  }
  save({ url: 'https://other.example.net/x', title: 'Other host', description: 'x',
    markdown: '# Other\n\nbody', html_bytes: 900, fetched_at: '2026-07-05T00:00:00.000Z' });

  const rel = related('https://blog.example.org/post-0');
  assert.equal(rel.host, 'blog.example.org', 'derives the current page host');
  assert.ok(rel.pages.length >= 2, 'surfaces the other same-host pages');
  assert.ok(rel.pages.every((p) => p.host === 'blog.example.org'), 'only same-host pages');
  assert.ok(!rel.pages.some((p) => p.url === 'https://blog.example.org/post-0'), 'excludes the current page');
  assert.ok(!rel.pages.some((p) => p.host === 'other.example.net'), 'no cross-host leak');
  assert.deepEqual(related('https://never.cached/x').pages, [], 'an uncached url yields an empty list, not an error');
});

test('overview: the reading history adds up — tokens saved, hosts, days, heaviest', async () => {
  const prevTZ = process.env.TZ;
  process.env.TZ = 'UTC';  // pin: by_day now buckets in LOCAL time, so fix the zone for the hardcoded dates
  try {
  // a second host, a different day, and a page whose raw HTML dwarfs its markdown
  save({ url: 'https://news.example.org/a', title: 'Bloated news page',
    markdown: 'Two sentences of actual content.',
    html_bytes: 400_000, fetched_at: '2026-07-03T00:00:00.000Z' });
  save({ url: 'https://news.example.org/b', title: 'Another from the same host',
    markdown: 'Short.', html_bytes: 8_000, fetched_at: '2026-07-03T09:00:00.000Z' });

  const o = overview();
  // the headline: raw HTML would have cost far more than the markdown scout kept
  assert.ok(o.html_tokens > o.md_tokens, 'raw html costs more than the kept markdown');
  assert.equal(o.saved_tokens, o.html_tokens - o.md_tokens, 'saved = html - markdown');
  assert.ok(o.saved_pct > 90, `a bloated corpus is >90% lighter (got ${o.saved_pct}%)`);
  assert.ok(o.pages >= 3, 'counts every cached page');   // other tests share this cache

  // hosts are grouped, ranked by pages
  const hosts = Object.fromEntries(o.by_host.map((h) => [h.host, h.pages]));
  assert.equal(hosts['news.example.org'], 2, 'groups both pages under one host');
  const counts = o.by_host.map((h) => h.pages);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a), 'hosts are ranked most-read first');

  // reading over time, oldest day first
  const days = o.by_day.map((d) => d.day);
  assert.deepEqual(days, [...days].sort(), 'days run oldest → newest');
  assert.ok(days.includes('2026-07-03'), 'the day those pages were read shows up');
  assert.equal(o.by_day.reduce((a, d) => a + d.pages, 0), o.pages, 'every page lands in exactly one day bucket');
  // heaviest = what raw HTML would have cost, worst first
  assert.equal(o.heaviest[0].title, 'Bloated news page', 'the 400KB page is the heaviest read');
  assert.ok(o.heaviest[0].html_tokens > o.heaviest[0].tokens * 10, 'and its html dwarfs its markdown');

  // a bad ?top must not empty every list (NaN → slice(0,NaN))
  assert.equal(overview({ top: 'abc' }).by_host.length, o.by_host.length, 'a bad top falls back to the default');
  assert.equal(overview({ top: 1 }).by_host.length, 1, 'top caps the lists');

  // and it is served
  const server = createScoutServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  try {
    const res = await fetch(base + '/api/overview').then((r) => r.json());
    assert.equal(res.saved_tokens, o.saved_tokens, '/api/overview serves the same digest');
  } finally { server.close(); }
  } finally { if (prevTZ === undefined) delete process.env.TZ; else process.env.TZ = prevTZ; }
});

test('overview buckets reads by the LOCAL day, not the UTC day', async () => {
  // fetched_at is a UTC timestamp; slicing its first 10 chars put a late-night read on the wrong
  // calendar day for a non-UTC reader. A page read at 23:30Z is "tomorrow" at UTC+14.
  const prevTZ = process.env.TZ;
  process.env.TZ = 'Pacific/Kiritimati';  // UTC+14 (fixed offset, no DST)
  try {
    save({ url: 'https://tz.example/late', title: 'Late-night read',
      markdown: 'Read just before midnight UTC.', html_bytes: 1000, fetched_at: '2026-03-15T23:30:00.000Z' });
    const days = overview().by_day.map((d) => d.day);
    assert.ok(days.includes('2026-03-16'), 'at UTC+14, 23:30Z on the 15th is the LOCAL 16th');
    assert.ok(!days.includes('2026-03-15'), 'and NOT the UTC 15th (the bug) — no other page fell on that UTC day');
  } finally { if (prevTZ === undefined) delete process.env.TZ; else process.env.TZ = prevTZ; }
});

test('serve: stats advertises where cortex lives, so an article can be kept in the brain', async () => {
  const server = createScoutServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  try {
    const s = await fetch(base + '/api/stats').then((r) => r.json());
    // scout never writes to cortex — it only tells the page which brain to POST to
    assert.equal(s.cortex, 'http://localhost:7800', 'defaults to cortex serve');
    assert.ok(s.pages > 0, 'and still carries the cache stats');
  } finally { server.close(); }
});

test('serve: POST /api/fetch reads a page into the library; a GET never can', async () => {
  const server = createScoutServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const post = (body) => fetch(base + '/api/fetch', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    // fetching reaches the network and writes the cache — a GET must never do that
    assert.equal((await fetch(base + '/api/fetch')).status, 405);
    const pre = await fetch(base + '/api/fetch', { method: 'OPTIONS' });
    assert.match(pre.headers.get('access-control-allow-methods'), /POST/);

    // guards, before anything touches the network
    assert.equal((await post({})).status, 400, 'a url is required');
    const bad = await post({ url: 'file:///etc/passwd' });
    assert.equal(bad.status, 400, 'only the web can be read');
    assert.match((await bad.json()).error, /http/);

    // the happy path, without hitting the network: an already-cached page comes
    // back from the read-through cache (this is the same page the harness seeded)
    const p = await post({ url: 'https://example.com/reconnect' }).then((r) => r.json());
    assert.equal(p.title, 'WebSocket reconnect backoff');
    assert.equal(p.from_cache, true, 'served from the cache, not re-fetched');
    assert.ok(p.markdown.includes('exponential backoff'));

    // and it is really in the library the shelf renders
    const lib = await fetch(base + '/api/library').then((r) => r.json());
    assert.ok(lib.pages.some((x) => x.url === 'https://example.com/reconnect'));
  } finally { server.close(); }
});

test('links: where a cached page points — from the cache, marking what you have read', async () => {
  const { pageLinks } = await import('../src/core.js');

  save({ url: 'https://hub.example.com/index', title: 'The hub',
    markdown: [
      'A page that points at things.',
      '',
      'Already read: [the reconnect piece](https://example.com/reconnect).',
      'Not yet: [an unread essay](https://elsewhere.example.org/essay).',
      'Again the same: [the reconnect piece](https://example.com/reconnect).',   // dedupe
      'Itself: [home](https://hub.example.com/index).',                          // not a lead
      'Not a page: [mail](mailto:a@b.c) and [rel](/relative/path).',             // only real web links
    ].join('\n'),
    html_bytes: 9000 });

  const l = pageLinks('https://hub.example.com/index');
  assert.equal(l.count, 2, 'deduped, self-links and non-http links dropped');

  const byHref = Object.fromEntries(l.links.map((x) => [x.href, x]));
  const read = byHref['https://example.com/reconnect'];
  assert.ok(read, 'the link it points at is there');
  assert.equal(read.in_library, true, 'and scout knows you already read it');
  assert.equal(read.title, 'WebSocket reconnect backoff', 'showing what it actually is, not the anchor text');
  assert.equal(read.host, 'example.com');

  const fresh = byHref['https://elsewhere.example.org/essay'];
  assert.equal(fresh.in_library, false, 'the unread one is marked unread');
  assert.equal(fresh.text, 'an unread essay', 'falling back to its anchor text');

  // cache-only: it never reaches the network to answer this
  assert.equal(pageLinks('https://never.fetched.example/x'), null);

  const server = createScoutServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  try {
    const res = await fetch(base + '/api/links?url=' + encodeURIComponent('https://hub.example.com/index')).then((r) => r.json());
    assert.equal(res.count, 2);
    const miss = await fetch(base + '/api/links?url=https://never.fetched.example/x');
    assert.equal(miss.status, 404, 'a page you have not read has no links to show');
  } finally { server.close(); }
});

// pageLinks (above) reads links from the CACHE. links() is the other one — the
// agent-facing `scout_links` tool and `scout links` CLI both call it — which FETCHES
// the page fresh and extracts where it points. That network leg had no coverage.
test('links: fetching a live page resolves relative hrefs, dedupes, and drops non-web links', async () => {
  const { links } = await import('../src/core.js');
  const { createServer } = await import('node:http');

  const origin = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html><body>
      <a href="https://external.example.org/post">an external post</a>
      <a href="/relative/page">a relative link</a>
      <a href="https://external.example.org/post">the same external post again</a>
      <a href="mailto:someone@example.com">mail me</a>
      <a href="#top">back to top</a>
    </body></html>`);
  });
  await new Promise((r) => origin.listen(0, r));
  const port = origin.address().port;
  const pageUrl = `http://localhost:${port}/hub`;
  try {
    const r = await links(pageUrl);
    const urls = r.links.map((x) => x.url);
    assert.ok(urls.includes('https://external.example.org/post'), 'the absolute link is kept');
    assert.ok(urls.includes(`http://localhost:${port}/relative/page`),
      'the relative href is resolved against the page it came from, not left bare');
    assert.equal(urls.filter((u) => u === 'https://external.example.org/post').length, 1,
      'the duplicate is collapsed to one');
    assert.ok(!urls.some((u) => /^(mailto:|#)/.test(u)), 'mail and in-page anchors are not places to crawl');
    assert.equal(r.count, r.links.length, 'count matches the list it returns');
    assert.equal(r.final_url, pageUrl, 'it reports where it actually landed');

    const one = await links(pageUrl, { limit: 1 });
    assert.equal(one.links.length, 1, 'the limit caps how many come back');
  } finally { origin.close(); }
});

test('re-read: the question is not "here it is again" but "did it change"', async () => {
  const { pageDiff } = await import('../src/core.js');

  // the diff is about meaning, not bytes: reformatting is not a change
  const same = pageDiff('# Title\n\nA line.\n', '# Title\n\n   A line.   \n\n');
  assert.equal(same.changed, false, 'whitespace and blank lines are not a change');

  const moved = pageDiff('# Title\n\nOld claim.\n', '# Title\n\nNew claim.\nAnd more.\n');
  assert.equal(moved.changed, true);
  assert.equal(moved.added, 2, 'two lines are new');
  assert.equal(moved.removed, 1, 'one is gone');

  // A change that only alters a line's COUNT is still a change. The old Set-based diff missed these: a
  // duplicate line added — or one of two identical lines removed — left both sets unchanged, so reread
  // reported "no change" (added:0) for a page that grew or shrank. reread's whole job, answered backwards,
  // exactly where repeated lines are involved (status rows, list items, boilerplate).
  const dupAdded = pageDiff('x\ny\nz', 'x\ny\nz\ny');
  assert.equal(dupAdded.changed, true, 'a duplicate line added is a change');
  assert.equal(dupAdded.added, 1, 'and it is counted, though the line already existed elsewhere');
  assert.equal(dupAdded.removed, 0);
  const swap = pageDiff('a\na\nb', 'a\nb\nb');
  assert.equal(swap.changed, true, 'one of two "a" lines becoming a "b" is a change, even at equal length');
  assert.equal(swap.added, 1);
  assert.equal(swap.removed, 1);
  // Over-fire guard: a pure reordering with identical content is NOT a change (same multiset) — the fix
  // counts multiplicity, it does not start flagging order.
  assert.equal(pageDiff('a\nb\nc', 'c\nb\na').changed, false, 'a reordering with identical content is not a change');

  const server = createScoutServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  try {
    // re-reading writes the cache and hits the network, so a GET must not do it
    assert.equal((await fetch(base + '/api/reread')).status, 405);

    // and you cannot re-read what you never read
    const unknown = await fetch(base + '/api/reread', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://never.read.example/x' }),
    });
    assert.equal(unknown.status, 404);
    assert.match((await unknown.json()).error, /not read this page/);
  } finally { server.close(); }
});

test('forget: a page can be dropped from the library — and a GET can never do it', async () => {
  const server = createScoutServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  try {
    save({ url: 'https://doomed.example/page', title: 'Doomed', markdown: 'unicorn-doomed content here.', html_bytes: 900 });

    assert.ok((await fetch(base + '/api/library').then((r) => r.json())).pages.some((p) => p.url === 'https://doomed.example/page'));
    assert.ok((await fetch(base + '/api/search?q=unicorn-doomed').then((r) => r.json())).results.some((r) => r.url === 'https://doomed.example/page'));

    // reading is not forgetting
    assert.ok((await fetch(base + '/api/page?url=' + encodeURIComponent('https://doomed.example/page'))).ok);
    assert.ok((await fetch(base + '/api/library').then((r) => r.json())).pages.some((p) => p.url === 'https://doomed.example/page'),
      'a GET left it alone');

    const gone = await fetch(base + '/api/page?url=' + encodeURIComponent('https://doomed.example/page'), { method: 'DELETE' });
    assert.equal(gone.status, 200);
    assert.equal((await gone.json()).forgotten, true);

    // it is gone from the shelf AND from search — not just hidden
    assert.ok(!(await fetch(base + '/api/library').then((r) => r.json())).pages.some((p) => p.url === 'https://doomed.example/page'));
    assert.ok(!(await fetch(base + '/api/search?q=unicorn-doomed').then((r) => r.json())).results.some((r) => r.url === 'https://doomed.example/page'),
      'forgotten means gone from the index too');

    assert.equal((await fetch(base + '/api/page?url=' + encodeURIComponent('https://doomed.example/page'), { method: 'DELETE' })).status, 404,
      'forgetting it twice is a 404, not a lie');
  } finally { server.close(); }
});

// ── Say what the tool does to the world ─────────────────────────────────────────
// MCP tool annotations. The spec's defaults are pessimistic: with NO annotations, a tool
// is declared destructive and open-world, and a conformant client should warn the user
// before calling it. So every one of these tools — including `scout_search` — was telling
// clients it might destroy something. You do not become safe by omission.
test('a search and a delete no longer look the same to a client', async () => {
  const { spawn } = await import('node:child_process');
  const list = await new Promise((resolve) => {
    const p = spawn('node', ['mcp/mcp-server.js'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    const done = (v) => { try { p.kill('SIGKILL'); } catch {} resolve(v); };
    setTimeout(() => done([]), 10000);
    p.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) { let m; try { m = JSON.parse(l); } catch { continue; }
        if (m.id === 2 && m.result?.tools) done(m.result.tools); }
    });
    const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  });

  assert.ok(list.length, 'the server answered');
  assert.ok(list.every((t) => t.annotations),
    `every tool must SAY what it does — silence means "destructive"; missing: ${list.filter((t) => !t.annotations).map((t) => t.name)}`);

  const search = list.find((t) => t.name === 'scout_search');
  assert.equal(search.annotations.readOnlyHint, true, 'a search changes nothing — the client can skip the confirm');
  assert.equal(search.annotations.openWorldHint, true, 'but what it hands back is a web page: content from outside the trust boundary');

  const forget = list.find((t) => t.name === 'scout_forget');
  assert.equal(forget.annotations.readOnlyHint, false);
  assert.equal(forget.annotations.destructiveHint, true, 'it deletes the cached page — warn first');
  assert.equal(forget.annotations.idempotentHint, true, 'forgetting twice forgets nothing more — safe to retry');

  const fetched = list.find((t) => t.name === 'scout_fetch');
  assert.equal(fetched.annotations.destructiveHint, false, 'fetching is additive — it caches, it does not destroy');
  assert.equal(fetched.annotations.openWorldHint, true, 'and it goes to the network');
});

// ── "fetch failed" is not an error message ──────────────────────────────────────
test('a fetch that fails says WHY, so an agent can do something about it', async () => {
  const { fetchPage } = await import('../src/core.js').then((m) => ({ fetchPage: m.fetchPage || m.fetch || m.get }));
  const { spawnSync } = await import('node:child_process');

  // Node's own message, in full, is "fetch failed" — three words that name no cause,
  // suggest no action, and cannot be told apart from a typo, a dead host, a DNS failure
  // or no network at all. The agent's next move is a guess.
  const dead = spawnSync('node', ['src/cli.js', 'fetch', 'http://127.0.0.1:9/nothing'], {
    encoding: 'utf8', env: { ...process.env, SCOUT_DB: '/tmp/scout-errtest.db' },
  });
  const msg = dead.stdout + dead.stderr;
  assert.match(msg, /could not fetch/i, 'it names the action that failed');
  assert.match(msg, /127\.0\.0\.1:9/, 'and the URL it tried, so a typo is visible');
  assert.doesNotMatch(msg, /^error: fetch failed$/m, 'and never just "fetch failed"');

  const nohost = spawnSync('node', ['src/cli.js', 'fetch', 'http://no-such-host-xyz-9999.invalid/'], {
    encoding: 'utf8', env: { ...process.env, SCOUT_DB: '/tmp/scout-errtest.db' },
  });
  const m2 = nohost.stdout + nohost.stderr;
  assert.match(m2, /no such host|offline/i, 'a dead domain says so, instead of "fetch failed"');
  assert.match(m2, /ENOTFOUND/, 'and keeps the code, for anyone who wants it');
});

// ── a redirect loop / an endless chain is a fetch that never arrives ─────────────
// fetch FOLLOWS redirects but caps at ~20 hops and throws. The raw cause is undici's
// internal "redirect count exceeded" — scout only ever read it because that phrase
// happens to be English, with no explicit case (the Cycle-95 fragility, one redirect
// over): a Node reword would silently degrade it, and it never told the agent this is
// TERMINAL. Name it deliberately; and never over-fire on an ordinary redirect.
test('a redirect loop is named as terminal — not passed through as "redirect count exceeded"', async (t) => {
  const { createServer } = await import('node:http');
  const { fetchUrl } = await import('../src/core.js');

  const srv = createServer((req, res) => {
    const u = req.url;
    if (u === '/loop')  { res.writeHead(302, { Location: '/loopb' }); return res.end(); }
    if (u === '/loopb') { res.writeHead(302, { Location: '/loop'  }); return res.end(); }
    if (u === '/hop')   { res.writeHead(302, { Location: '/dest'  }); return res.end(); } // one honest redirect
    if (u === '/dest')  { res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html><head><title>Arrived</title></head><body><h1>Arrived</h1><p>Got here after one hop.</p></body></html>'); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;

  await assert.rejects(
    () => fetchUrl(`${base}/loop`, { fresh: true, timeout: 5000 }),
    (err) => {
      assert.match(err.message, /could not fetch/i, 'it names the action that failed');
      assert.match(err.message, /redirect loop|redirects too many times/i, 'and names the cause as a redirect problem');
      assert.match(err.message, /will not help|cannot be reached/i, 'and says it is terminal — do not just retry the same URL');
      assert.doesNotMatch(err.message, /redirect count exceeded/i, 'and never passes through undici’s raw internal phrase');
      return true;
    },
  );

  // The over-fire guard: an ORDINARY single redirect must still be followed to the page,
  // not mistaken for the pathology (Node follows up to ~20; one hop is nothing).
  const ok = await fetchUrl(`${base}/hop`, { fresh: true, timeout: 5000 });
  assert.equal(ok.title, 'Arrived', 'a normal redirect is followed through to the page');
  assert.match(ok.markdown, /Got here after one hop/, 'and its body comes back as markdown');
});

// ── a 404 page is not the article ────────────────────────────────────────────────
// A 4xx/5xx still has a body — usually a friendly HTML error page — and scout converts it
// to clean markdown like any other. Handed back unqualified, an agent reads "Oops, not
// found — try our homepage" as if it were the content it asked for. The status is there, in
// a sibling field it may never look at. Lead the markdown with the truth; leave the body.
test('a 404/500 error page is flagged as an error, not handed back as the article', async (t) => {
  const { createServer } = await import('node:http');
  const { fetchUrl } = await import('../src/core.js');

  const body = (h1, p) => `<!doctype html><html><head><title>${h1}</title></head><body><h1>${h1}</h1><p>${p}</p></body></html>`;
  const srv = createServer((req, res) => {
    if (req.url === '/gone') { res.writeHead(404, { 'content-type': 'text/html' });
      return res.end(body('Page not found', 'Oops! Try our homepage or search.')); }
    if (req.url === '/boom') { res.writeHead(500, { 'content-type': 'text/html' });
      return res.end(body('Server error', 'Something went wrong on our end.')); }
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(body('Real Article', 'The actual content an agent came here to read.'));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;

  const gone = await fetchUrl(`${base}/gone`, { fresh: true, timeout: 5000 });
  assert.equal(gone.status, 404, 'the status is preserved');
  assert.match(gone.markdown.slice(0, 200), /HTTP 404/, 'and the markdown LEADS with the status — not buried in a field');
  assert.match(gone.markdown, /error page|not the content|Not Found/i, 'and says plainly it is an error page, not the article');

  const boom = await fetchUrl(`${base}/boom`, { fresh: true, timeout: 5000 });
  assert.match(boom.markdown.slice(0, 200), /HTTP 500/, 'a 500 is flagged the same way');

  // Over-fire guard: a normal 200 must NOT be annotated — the note only appears on real errors.
  const ok = await fetchUrl(`${base}/ok`, { fresh: true, timeout: 5000 });
  assert.equal(ok.status, 200);
  assert.doesNotMatch(ok.markdown, /HTTP \d\d\d|error page/i, 'a 200 gets no error note');
  assert.match(ok.markdown, /actual content an agent came here to read/, 'just the content');
});

// ── a page is not always UTF-8 ───────────────────────────────────────────────────
// scout decoded every response as UTF-8. A Shift-JIS / GBK / Latin-1 page — legacy and regional
// sites still serve millions — then came back as mojibake for every non-ASCII byte, and the
// Content-Type header said which encoding it actually was the whole time.
test('a non-UTF-8 page is decoded in the charset the server declared, not mojibake', async (t) => {
  const { createServer } = await import('node:http');
  const { fetchUrl } = await import('../src/core.js');

  const srv = createServer((req, res) => {
    if (req.url === '/latin1') {
      // "Café résumé naïve" in ISO-8859-1: é=0xE9, ï=0xEF — NOT valid UTF-8.
      res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' });
      return res.end(Buffer.concat([Buffer.from('<title>t</title><body><p>Caf'), Buffer.from([0xE9]),
        Buffer.from(' r'), Buffer.from([0xE9]), Buffer.from('sum'), Buffer.from([0xE9]),
        Buffer.from(' na'), Buffer.from([0xEF]), Buffer.from('ve</p>')]));
    }
    if (req.url === '/sjis') {   // こんにちは in Shift-JIS
      res.writeHead(200, { 'content-type': 'text/html; charset=shift_jis' });
      return res.end(Buffer.concat([Buffer.from('<title>t</title><body><p>'),
        Buffer.from([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd]), Buffer.from('</p>')]));
    }
    if (req.url === '/bogus') {  // an unknown charset label must NOT crash the fetch — fall back to UTF-8
      res.writeHead(200, { 'content-type': 'text/html; charset=x-made-up-9000' });
      return res.end('<title>t</title><body><p>bogus charset still returns</p>');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });   // /utf8: unaffected
    res.end('<title>t</title><body><p>utf8 café résumé</p>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;

  const l1 = await fetchUrl(`${base}/latin1`, { fresh: true, timeout: 5000 });
  assert.match(l1.markdown, /Café résumé naïve/, 'a Latin-1 page decodes to the real accented text');
  assert.doesNotMatch(l1.markdown, /�/, 'and carries no replacement characters');

  const sj = await fetchUrl(`${base}/sjis`, { fresh: true, timeout: 5000 });
  assert.match(sj.markdown, /こんにちは/, 'a Shift-JIS page decodes to the real Japanese text');

  // Over-fire guards: an unknown charset must fall back (not throw), and UTF-8 is unchanged.
  const bg = await fetchUrl(`${base}/bogus`, { fresh: true, timeout: 5000 });
  assert.match(bg.markdown, /bogus charset still returns/, 'an unknown charset falls back to UTF-8, never crashes');
  const u8 = await fetchUrl(`${base}/utf8`, { fresh: true, timeout: 5000 });
  assert.match(u8.markdown, /café résumé/, 'a UTF-8 page is decoded exactly as before');
});

// The charset is often declared ONLY in the markup, not the HTTP header — a <meta charset> or a BOM.
// Header-only detection (the prior fix) left those pages mojibake. Sniff the document too, in the spec's
// precedence: header > BOM > <meta> > UTF-8 (a higher source overrides a lying lower one).
test('a charset declared only in <meta> or a BOM is honoured — and the header still outranks both', async (t) => {
  const { createServer } = await import('node:http');
  const { fetchUrl } = await import('../src/core.js');

  const bytes = (...parts) => Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  const srv = createServer((req, res) => {
    if (req.url === '/meta-sjis') {          // <meta charset>, header has NO charset — こんにちは in Shift-JIS
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(bytes('<meta charset="shift_jis"><body><p>', Buffer.from([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd]), '</p>'));
    }
    if (req.url === '/meta-httpequiv') {     // old http-equiv form, Latin-1
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(bytes('<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"><body><p>Caf', Buffer.from([0xE9]), '</p>'));
    }
    if (req.url === '/bom-beats-meta') {     // UTF-8 BOM but a LYING <meta latin1> → BOM wins
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(bytes(Buffer.from([0xEF, 0xBB, 0xBF]), '<meta charset="iso-8859-1"><body><p>café bom</p>'));
    }
    // header utf-8 but a LYING <meta shift_jis> → the header outranks the markup
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<meta charset="shift_jis"><body><p>café header</p>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const md = async (p) => (await fetchUrl(`${base}${p}`, { fresh: true, timeout: 5000 })).markdown;

  assert.match(await md('/meta-sjis'), /こんにちは/, 'a <meta charset> Shift-JIS page decodes from the markup declaration');
  assert.match(await md('/meta-httpequiv'), /Café/, 'the old http-equiv form is honoured too');
  const bom = await md('/bom-beats-meta');
  assert.match(bom, /café bom/, 'a BOM outranks a lying <meta>');
  assert.doesNotMatch(bom, /^﻿|ï»¿/, 'and the BOM itself is not left in the text');
  assert.match(await md('/header'), /café header/, 'and an HTTP header charset still outranks the markup');
});

// A #fragment is client-side only — never sent to the server — so page#a and page#b are the SAME
// fetched resource. Keeping it in the cache key re-fetched the whole page for every section deep-link
// and listed one article as many rows in the reading room.
test('a #fragment does not defeat the cache — page#a and page#b are one entry, but ?q=a and ?q=b are two', async (t) => {
  const { createServer } = await import('node:http');
  const { fetchUrl, library } = await import('../src/core.js');

  let hits = 0;
  const srv = createServer((req, res) => { hits++; res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>t</title><body><p>body of ' + req.url + '</p></body>'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;

  await fetchUrl(`${base}/article#section-1`, { fresh: true });
  const second = await fetchUrl(`${base}/article#section-2`);   // not fresh — must hit the cache
  assert.equal(second.from_cache, true, 'a different #fragment of the same page is served from cache');
  assert.equal(hits, 1, 'the server was hit once, not once per section');
  // Scoped to THIS server's unique port — serve.test.js shares one cache DB across all tests.
  const mine = () => library().pages.filter((p) => p.url.startsWith(base));
  assert.equal(mine().filter((p) => p.url.endsWith('/article')).length, 1, 'the reading room lists the article ONCE, not per-fragment');
  assert.equal(mine().some((p) => p.url.includes('#')), false, 'and no reading-room URL carries a #fragment');

  // Over-fire guard: the query string IS part of the resource — different queries stay distinct.
  await fetchUrl(`${base}/s?q=cats`, { fresh: true });
  await fetchUrl(`${base}/s?q=dogs`, { fresh: true });
  assert.equal(mine().filter((p) => p.url.includes('/s?')).length, 2, 'distinct query strings are kept separate');
});

// A read never creates the store (so a tool never litters a directory it was only asked a question in).
// forget is a WRITE — but forgetting a URL that was never cached, on a machine with no cache at all,
// must not conjure a .scout/ into existence just to delete nothing. And a real forget must take BOTH the
// page row and its FTS row, atomically, the way save() writes them.
test('forget does not litter a store into existence, and it removes both the page and its FTS row', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: pjoin } = await import('node:path');
  const { createServer } = await import('node:http');
  const { fetchUrl, forget, search, library } = await import('../src/core.js');

  // 1) forget on a cacheless machine must create NOTHING.
  const fresh = mkdtempSync(pjoin(tmpdir(), 'scout-forget-'));
  t.after(() => rmSync(fresh, { recursive: true, force: true }));
  const out = spawnSync('node', ['src/cli.js', 'forget', 'https://example.com/never-cached'],
    { encoding: 'utf8', env: { ...process.env, SCOUT_DB: pjoin(fresh, '.scout', 'cache.db') } });
  assert.ok(!existsSync(pjoin(fresh, '.scout')), 'forgetting an uncached URL created no store — no litter');
  assert.match(out.stdout + out.stderr, /"forgotten":\s*false/, 'and it reports nothing was forgotten');

  // 2) a real cached page: forget takes it out of the reading room AND search.
  const srv = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>Forgettable</title><body><article><h1>Forgettable</h1><p>zzforgetprobe is a unique word ' +
      'in a body long enough to survive readability and land in the FTS index for this test to mean something.</p>' +
      '</article></body>'); });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  t.after(() => srv.close());
  const url = `http://127.0.0.1:${srv.address().port}/p`;
  await fetchUrl(url, { fresh: true });
  assert.ok(search('zzforgetprobe').results.some((h) => h.url === url), 'precondition: the page IS searchable before forget');
  assert.equal(forget(url).forgotten, true, 'a cached page is forgotten');
  assert.equal(library().pages.filter((p) => p.url === url).length, 0, 'gone from the reading room');
  assert.equal(search('zzforgetprobe').results.filter((h) => h.url === url).length, 0, 'and gone from search — the FTS row went too');
  assert.equal(forget(url).forgotten, false, 'forgetting it again forgets nothing more — idempotent');
});

// ── stdout IS the protocol ──────────────────────────────────────────────────────
// An MCP server speaks newline-delimited JSON-RPC on stdout and NOTHING else.
//
// One console.log anywhere in a code path a tool can reach — a leftover debug line, a
// helpful progress message — puts a line on that stream which is not a message. The
// client desyncs. It does not fail loudly: the call simply never comes back, or comes
// back as the wrong reply to the wrong request, and the agent is left holding a session
// that has quietly stopped working. It is the single easiest way to break an MCP server,
// and the hardest to notice, because everything still LOOKS fine.
//
// A dynamic check cannot cover this: it only sees the code paths it happens to exercise,
// and a debug line inside `search()` is invisible until someone searches. So walk the
// import graph from the server itself and refuse the whole class.
//
// `cli.js` and `server.js` are the CLI and the `serve` command — they are meant to print,
// and the MCP server never imports them. If that ever changes, this test is what tells you.
test('nothing the MCP server can reach is allowed to print to stdout', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { dirname, resolve, relative } = await import('node:path');

  const entry = resolve(import.meta.dirname, '..', 'mcp', 'mcp-server.js');
  const seen = new Set();
  const offenders = [];

  const walk = (file) => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');

    // The server itself writes the protocol — that is its job. Everything it pulls in must not.
    if (file !== entry) {
      src.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;                       // a comment about it is fine
        if (/console\.(log|info|debug|dir|table)\s*\(|process\.stdout\.write\s*\(/.test(line)) {
          offenders.push(`${relative(process.cwd(), file)}:${i + 1}  ${line.trim().slice(0, 70)}`);
        }
      });
    }
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      walk(resolve(dirname(file), m[1]));
    }
  };
  walk(entry);

  // agent-hq's MCP server imports nothing local — it is a thin HTTP client over the
  // platform's API — so for it this walk finds only the entry file, and there is genuinely
  // nothing to check. That is not a vacuous pass: it is the guard that fires the day
  // somebody wires the server straight into services.js, which does print.
  assert.ok(seen.size >= 1, 'the entry point was found');
  assert.deepEqual(offenders, [],
    'stdout is the protocol — one stray print desyncs every agent session:\n  ' + offenders.join('\n  '));
});

// ── The state my machine never enters ───────────────────────────────────────────
test('a brand-new user, with no cache at all, can still run every read command', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { spawnSync } = await import('node:child_process');

  // A read no longer CREATES the store — that fix stopped the tools littering every
  // directory they were asked a question in. Which means `get()` returns undefined when
  // there is no store, and `.n` on undefined is a TypeError.
  //
  // So `scout serve` CRASHED AT STARTUP on a machine with no cache: stats() runs before the
  // server listens. A brand-new user's very first command died — and nothing caught it,
  // because the tests seed, the CI gate seeds, and my own machine has had a cache for weeks.
  // The bug lived in a state nothing here ever entered, and I put it there myself while
  // fixing something else.
  const dir = mkdtempSync(join(tmpdir(), 'scout-firstrun-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = resolve(import.meta.dirname, '..', 'src', 'cli.js');
  const env = { ...process.env, SCOUT_DB: join(dir, 'cache.db') };

  for (const args of [['stats'], ['list'], ['search', 'anything'], ['overview']]) {
    const r = spawnSync('node', [cli, ...args], { encoding: 'utf8', env });
    const said = r.stdout + r.stderr;
    assert.doesNotMatch(said, /TypeError|Cannot read properties/,
      `\`scout ${args.join(' ')}\` on an empty cache must not crash — that is a new user's first command; got: ${said.slice(0, 120)}`);
    assert.equal(r.status, 0, `\`scout ${args.join(' ')}\` exits cleanly with nothing cached`);
  }
});

// ASKING A QUESTION MUST NOT LEAVE A .scout/ BEHIND IN SOMEONE ELSE'S DIRECTORY.
//
// db.js used to open the database AT IMPORT — mkdir, create the file, run the schema — so
// merely ASKING brought the cache into existence. `scout search` in a home directory left a
// .scout/ in it. And the empty cache it had just created then ANSWERED the question, with
// nothing, which reads as "you never read that". The tool invented the evidence for its own
// answer.
//
// cortex has had a test for this since the day it was fixed. scout never got one — a canary
// mutant flipped the read back to open(true) and the whole suite stayed green.
test('asking a question does not leave a cache behind in someone else\'s directory', async (t) => {
  const { mkdtempSync, rmSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { spawnSync } = await import('node:child_process');

  const dir = mkdtempSync(join(tmpdir(), 'scout-nolitter-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const cli = resolve(import.meta.dirname, '..', 'src', 'cli.js');
  const r = spawnSync('node', [cli, 'search', 'anything'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, SCOUT_DB: join(dir, '.scout', 'cache.db') },
  });

  assert.equal(r.status, 0, 'the question is answered');
  assert.match(r.stdout, /0 hits of 0 pages read/, 'and the answer carries the size of the haystack');
  assert.match(r.stdout, /have not read anything yet/,
    'and says the cache is empty, rather than implying the web does not contain it');
  assert.deepEqual(readdirSync(dir), [], 'and NOTHING was created — the directory is exactly as it was');
});

// `truncated` IS A CLAIM ABOUT THE CONTENT, and nothing was checking it.
//
// scout's whole promise is "a web page, small enough to fit in your budget". When a page does
// not fit, it is cut — and the caller is told so. Three separate mutants survived here: the
// flag could be hardcoded (`let truncated = false` -> true), the boundary could slip
// (`>` -> `>=`), and the slice could be inverted. The suite stayed green for all of them.
//
// Both directions, because either one alone is a half-truth:
//   · a page that WAS cut and says it wasn't → an agent reasons about a document it half read
//   · a page that was NOT cut and says it was → an agent distrusts a complete answer and refetches
test('a page too big for the budget is cut, AND SAYS SO — a whole one says nothing of the kind', async () => {
  const { fetchUrl } = await import('../src/core.js');
  const long = ('the quick brown fox jumps over the lazy dog. '.repeat(400));   // ~4.5k tokens
  save({ url: 'https://example.com/long', title: 'Long', markdown: long, status: 200 });
  save({ url: 'https://example.com/short', title: 'Short', markdown: 'one short line.', status: 200 });

  const cut = await fetchUrl('https://example.com/long', { max_tokens: 100 });
  assert.equal(cut.from_cache, true, 'read through the cache — no network in a test');
  assert.equal(cut.truncated, true, 'the page did not fit, and the caller is TOLD it did not fit');
  assert.ok(cut.tokens <= 130, `and it is actually within the budget, got ${cut.tokens}`);
  assert.match(cut.markdown, /\[truncated/, 'and the text itself says where it stops');

  const whole = await fetchUrl('https://example.com/short', { max_tokens: 100 });
  assert.equal(whole.truncated, false, 'a page that fits is NOT reported as cut');
  assert.match(whole.markdown, /one short line\./, 'and it comes back whole');
  assert.doesNotMatch(whole.markdown, /\[truncated/, 'with nothing appended to it');
});

// NOBODY HAD EVER MADE SCOUT FETCH ANYTHING.
//
// Every test in this suite reaches the cache through save(), so fetchUrl — THE TOOL'S MAIN
// PATH, the one an agent takes every single time — was exercised by nothing. Two mutants
// proved it: `fresh = false` could flip to `true` (every read goes to the network, the cache
// stops existing) and the HTML sniff could turn from `||` to `&&`, and the suite stayed green.
//
// The page below is the awkward one that a tidy fixture never is: it is served as text/html but
// it does NOT start with <!doctype — it opens with a comment, exactly like half the pages on the
// web. Under `&&` it would not be recognised as HTML, and scout would hand an agent the RAW
// HTML instead of clean markdown — which is the entire promise of the tool, in reverse.
test('scout actually fetches: a real page, sniffed, converted, cached — and refetched on demand', async (t) => {
  const { createServer } = await import('node:http');
  const { fetchUrl } = await import('../src/core.js');

  let hits = 0;
  const srv = createServer((req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    // No doctype. Opens with a comment. Perfectly ordinary, and fatal to a stricter sniff.
    res.end('<!-- built by a generator -->\n<html><head><title>Real Page</title></head>' +
      '<body><h1>Real Page</h1><p>The body an agent came for.</p></body></html>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const url = `http://127.0.0.1:${srv.address().port}/page`;

  const first = await fetchUrl(url);
  assert.equal(first.from_cache, false, 'the first read goes to the network');
  assert.equal(hits, 1, 'and the server saw exactly one request');
  assert.equal(first.title, 'Real Page', 'the title is extracted — so it WAS recognised as HTML');
  assert.match(first.markdown, /^# Real Page/m, 'and the body came back as markdown');
  assert.doesNotMatch(first.markdown, /<h1>|<html>/, 'NOT as the raw HTML an agent cannot afford');

  const second = await fetchUrl(url);
  assert.equal(second.from_cache, true, 'the second read is served from the cache');
  assert.equal(hits, 1, 'and the server was NOT asked again — the cache is the whole point');

  const forced = await fetchUrl(url, { fresh: true });
  assert.equal(forced.from_cache, false, 'fresh: true goes back to the network on purpose');
  assert.equal(hits, 2, 'and only then is the server asked a second time');

  // raw: true is a documented scout_fetch option — return the ORIGINAL response, not the readability
  // extraction. An agent asks for it when markdown would lose what it needs: the actual tag structure,
  // a table markdown flattens, a <script> payload. The condition is `raw || !isHtml`, and a mutant
  // turning it to `&&` meant a raw:true request on an HTML page got converted ANYWAY — the option
  // silently ignored. Nothing tested it (the other "raw" mentions here are the overview's byte-count
  // digest, not the fetch flag). fresh:true too, so this hits the network and re-derives.
  const rawResp = await fetchUrl(url, { raw: true, fresh: true });
  assert.match(rawResp.markdown, /<h1>Real Page<\/h1>/, 'raw:true returns the ORIGINAL HTML, tags intact');
  assert.match(rawResp.markdown, /<!-- built by a generator -->/, 'the whole response, comment and all');
  assert.doesNotMatch(rawResp.markdown, /^# Real Page/m, 'and specifically NOT the markdown conversion');
});

// "HAS THIS PAGE CHANGED SINCE I READ IT?" — the re-read feature, exposed on the web view's ↻ button
// via /api/reread. It re-fetches a page and diffs it against your cached copy. pageDiff (the line
// diff behind it) and reread (the integration) were both uncovered — coverage flagged the exact lines.
test('pageDiff reports added and removed lines by identity, not position', async () => {
  const { pageDiff } = await import('../src/core.js');
  assert.deepEqual(pageDiff('a\nb\nc', 'a\nb\nc'), { changed: false, added: 0, removed: 0, was_lines: 3, now_lines: 3 },
    'an identical page has not changed');
  const addOnly = pageDiff('a\nb', 'a\nb\nc');
  assert.equal(addOnly.added, 1, 'a new line is one addition');
  assert.equal(addOnly.changed, true, 'and a page that only GAINED a line has still changed');
  const rmOnly = pageDiff('a\nb\nc', 'a\nc');
  assert.equal(rmOnly.removed, 1, 'a gone line is one removal');
  assert.equal(rmOnly.changed, true, 'and a page that only LOST a line has still changed');
  const both = pageDiff('a\nold line', 'a\nnew line');
  assert.equal(both.changed, true, 'a swapped line is a change');
  assert.equal(both.added, 1); assert.equal(both.removed, 1, 'counted as one add and one remove');
});

test('reread fetches a page again and tells you what changed — or null if you never read it', async (t) => {
  const { createServer } = await import('node:http');
  const { fetchUrl, reread } = await import('../src/core.js');

  let body = '<html><head><title>News</title></head><body><h1>News</h1><p>First story.</p></body></html>';
  const srv = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(body); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const url = `http://127.0.0.1:${srv.address().port}/news`;

  assert.equal(await reread(url), null, 'you cannot re-read a page you never read — it returns null, not a fetch');

  await fetchUrl(url);                                   // read it once (caches "First story.")
  body = body.replace('First story.', 'Second story, added a line.');   // the page changes on the origin

  const r = await reread(url);
  assert.ok(r, 'now that it is cached, re-read returns a result');
  assert.equal(r.diff.changed, true, 'and it noticed the page changed');
  assert.ok(r.diff.added >= 1, 'a line was added');
  assert.ok(r.previously_read, 'it remembers when you last read it');
  assert.match(r.markdown, /Second story/, 'and returns the fresh content, not the stale cache');
});

test('fetching a binary resource returns a clear placeholder, not decoded-mojibake garbage', async () => {
  // `res.text()` never throws on binary — it fills the string with replacement chars — so a
  // PDF/image used to come back as garbage that read like a successful page and poisoned the
  // cache + FTS. Now it is caught (by content-type or a mostly-non-text body) and named.
  const { fetchUrl } = await import('../src/core.js');
  const { createServer } = await import('node:http');
  const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, ...Array(300).fill(0x99)]);
  const origin = createServer((req, res) => {
    if (req.url.includes('png')) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png); }
    else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ hello: 'wörld', İ: 'stanbul' })); }
  });
  await new Promise((r) => origin.listen(0, r));
  const base = `http://localhost:${origin.address().port}`;
  try {
    const bin = await fetchUrl(base + '/photo.png');
    assert.match(bin.markdown, /binary resource \(image\/png\)/, 'the binary result names what it is');
    assert.equal((bin.markdown.match(/�/g) || []).length, 0, 'and carries NO replacement-char garbage');
    assert.equal(bin.content_type, 'image/png', 'the content type is surfaced so the agent can see why');

    // a text response that merely contains non-ASCII is NOT binary — it stays verbatim.
    const json = await fetchUrl(base + '/data.json');
    assert.match(json.markdown, /wörld/, 'JSON with non-ASCII is stored verbatim, not mistaken for binary');
    assert.doesNotMatch(json.markdown, /binary resource/, 'and is not flagged as binary');
  } finally { origin.close(); }
});

test('an oversized page is read up to a cap and SAYS it stopped — never a silent truncation', async () => {
  // `res.text()` buffers the WHOLE response — a runaway page would spike memory and bloat the
  // cache. scout now streams up to a byte cap and leads with a note (so it survives the token cut).
  const { fetchUrl } = await import('../src/core.js');
  const { createServer } = await import('node:http');
  const prev = process.env.SCOUT_MAX_BYTES;
  process.env.SCOUT_MAX_BYTES = '40000';  // 40KB, so the test never rides on the network being fast
  let big = '<!doctype html><title>Big</title><body><main>';
  while (big.length < 300000) big += '<p>İstanbul Москва readable prose sentence. </p>\n';  // multi-byte across chunk edges
  big += '</main></body>';
  const small = '<!doctype html><title>Small</title><body><main><p>A short İstanbul page.</p></main></body>';
  const srv = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(req.url.includes('big') ? big : small); });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://localhost:${srv.address().port}`;
  try {
    const B = await fetchUrl(base + '/big', { fresh: true });
    assert.match(B.markdown, /scout read only the first 40KB of this oversized page/, 'the cap is announced, up front');
    assert.ok(B.html_bytes < 100000, `only ~40KB was read, not the full 300KB (got ${B.html_bytes})`);
    assert.equal((B.markdown.match(/�/g) || []).length, 0, 'non-ASCII survives the chunked read — no split-char mojibake');

    const S = await fetchUrl(base + '/small', { fresh: true });
    assert.doesNotMatch(S.markdown, /scout read only/, 'a page under the cap is read whole, not annotated');
    assert.match(S.markdown, /İstanbul/, 'and reads normally');
  } finally {
    srv.close();
    if (prev === undefined) delete process.env.SCOUT_MAX_BYTES; else process.env.SCOUT_MAX_BYTES = prev;
  }
});

test('a SAVE must not make a page VANISH while it is being saved', async () => {
  // save() upserts the page row (atomic) and then DELETEs + INSERTs its FTS entry — two more
  // statements, two more transactions. A search landing between them sees the page with NO FTS row,
  // so scout answers "0 hits across your reading" for a page that is right there in the cache.
  // Measured: 22,811 searches during a concurrent save, fewest pages ever visible 29 of 30 — one page
  // silently invisible at a time, and never zero overall, so nothing ever looked broken.
  const { execFile } = await import('node:child_process');
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: pjoin } = await import('node:path');

  const dir = mkdtempSync(pjoin(tmpdir(), 'scout-race-'));
  const core = new URL('../src/core.js', import.meta.url).href;
  const env = { ...process.env, SCOUT_DB: pjoin(dir, 'cache.db') };
  const N = 15;

  // The window is the time between the FTS DELETE and the FTS INSERT, so make the INSERT SLOW: a big
  // markdown body means a big FTS write. With a tiny body the gap is microseconds and the race only
  // reproduces on some machines — it survived this canary in CI while dying locally, which is a test
  // that only SOMETIMES guards. Widen the window until the bug is deterministic, or do not claim it.
  // 🔑 THE SEARCHER MUST RUN FOR EXACTLY AS LONG AS THE WRITER — NOT FOR A FIXED TIME.
  // My first cut gave the searcher a fixed 2.5s window and hoped it overlapped the writes. It caught
  // the race on my machine and MISSED it in CI, so the canary SURVIVED there: a race test that only
  // sometimes reproduces the race only sometimes guards, and a flaky canary teaches you to ignore the
  // gate. The writer now drops a sentinel when it finishes and the searcher polls until it appears —
  // full overlap, every run, on any hardware. (The big body also widens the DELETE→INSERT window.)
  const done = pjoin(dir, 'DONE');
  const saver = pjoin(dir, 'save.mjs');
  writeFileSync(saver, `
    import fs from 'node:fs';
    const m = await import(${JSON.stringify(core)});
    const big = 'zzracepage lorem ipsum dolor sit amet '.repeat(4000);   // ~150KB → a slow FTS write
    for (let r = 0; r < 25; r++) for (let i = 0; i < ${N}; i++)
      m.save({ url: 'https://ex.com/p' + i, title: 'Page ' + i, markdown: big, html_bytes: 100 });
    fs.writeFileSync(${JSON.stringify(done)}, 'x');
  `);
  const seek = pjoin(dir, 'seek.mjs');
  writeFileSync(seek, `
    import fs from 'node:fs';
    const m = await import(${JSON.stringify(core)});
    let min = 1e9;
    while (!fs.existsSync(${JSON.stringify(done)})) {
      const r = m.search('zzracepage', { k: 50 });
      if (r.matched < min) min = r.matched;
    }
    console.log(min);
  `);

  const run = (s) => new Promise((res, rej) =>
    execFile(process.execPath, [s], { env, encoding: 'utf8' }, (e, out) => (e ? rej(e) : res(out))));

  try {
    await run(saver);                                  // seed the cache
    rmSync(done, { force: true });                     // …and clear the sentinel the seed run dropped
    const [, seen] = await Promise.all([run(saver), run(seek)]);   // save WHILE searching
    assert.equal(+seen.trim(), N,
      `every search during a save must see all ${N} pages — the fewest seen was ${seen.trim()}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The same guarantee as the race above, but DETERMINISTIC — no timing, no CPU luck.
// 🔑 The race test only reproduces the vanish window when the searcher happens to run DURING it,
// and under CI CPU-starvation it did not: the canary SURVIVED in CI while dying locally, TWICE.
// A canary that only sometimes fires is a gate that only sometimes gates — the exact thing this
// project refuses to ship. `atomically` takes a callback, so we do not have to RACE the gap: we
// stand in it. Do save()'s exact FTS rewrite (DELETE then INSERT) inside atomically, and have a
// SECOND connection read at the split point. WAL gives that reader a snapshot: with a real
// transaction it sees the OLD entry (still there); with the BEGIN removed the DELETE auto-commits
// and the reader sees NOTHING — 0 hits for a page that is right there. Fires every run, any hardware.
test('atomically keeps a save atomic to a concurrent reader — deterministically (the VANISH canary)', async (t) => {
  const { DatabaseSync } = await import('node:sqlite');
  const { atomically, run: dbRun } = await import('../src/db.js');
  const url = 'https://ex.com/atomic-probe';
  const TOKEN = 'zzatomicprobe';
  save({ url, title: 'Atomic Page', markdown: `${TOKEN} body text`, html_bytes: 100 });

  // conn B: a SEPARATE connection — the concurrent reader. WAL is already on (the store is open).
  const connB = new DatabaseSync(process.env.SCOUT_DB);
  connB.exec('PRAGMA busy_timeout = 5000;');
  t.after(() => { try { connB.close(); } catch { /* already closed */ } });
  const readerSees = () => connB.prepare('SELECT COUNT(*) n FROM pages_fts WHERE pages_fts MATCH ?').get(TOKEN).n;

  assert.equal(readerSees(), 1, 'sanity: the reader sees the page before any rewrite');

  let seenAtGap = null;
  atomically(() => {
    dbRun('DELETE FROM pages_fts WHERE url=?', url);          // exactly what save() does…
    seenAtGap = readerSees();                                 // …and the concurrent reader, RIGHT in the gap
    dbRun('INSERT INTO pages_fts (url,title,markdown) VALUES (?,?,?)', url, 'Atomic Page', `${TOKEN} body text`);
  });

  assert.equal(seenAtGap, 1,
    'a reader between the FTS DELETE and INSERT must still see the page — the rewrite is one transaction, '
    + 'not two separately-committed statements (with BEGIN removed this reads 0: the page vanished mid-save)');
  assert.equal(readerSees(), 1, 'and it is still there afterwards');
});

test('an UNREADABLE cache is not an empty one — the CLI must not print "undefined hits"', async () => {
  // The core was HONEST: search() returns { error } when the cache cannot be read. The CLI threw that
  // honesty away — it printed "— undefined hits, ~undefined tokens —" and said nothing else. An agent
  // reads that as NO HITS. The tool KNEW it had failed and did not say so, which is the confident wrong
  // answer in its purest form. (lens's CLI already got this right; scout's and cortex's did not.)
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, rmSync, writeFileSync: wf } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: pjoin } = await import('node:path');
  const { randomBytes } = await import('node:crypto');

  const dir = mkdtempSync(pjoin(tmpdir(), 'scout-corrupt-'));
  const db = pjoin(dir, 'cache.db');
  wf(db, randomBytes(4096));                       // a file that is NOT a database
  const cli = new URL('../src/cli.js', import.meta.url).pathname;

  try {
    let out = '', code = 0;
    try {
      execFileSync(process.execPath, [cli, 'search', 'anything'],
        { env: { ...process.env, SCOUT_DB: db }, encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      code = e.status;
      out = `${e.stdout || ''}${e.stderr || ''}`;
    }
    assert.notEqual(code, 0, 'an unreadable cache must FAIL, not succeed with nothing');
    assert.doesNotMatch(out, /undefined hits/, 'never "undefined hits" — that reads as "no hits"');
    assert.match(out, /could not search/i, 'it says it could not search');
    assert.match(out, /NOT "you have not read that"/, 'and that this is not an empty result');
    assert.match(out, /re-fetch|delete/i, 'and what to do about it');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a connection that DROPS mid-download is named — not the bare word "terminated"', async () => {
  // A truncation is not a 404 and not a dead host: the page STARTED arriving and the socket closed
  // before it finished, so what you have is HALF a document. Node throws a bare "terminated" for this
  // (UND_ERR_SOCKET), and it used to reach the agent unmapped — worse, it bypassed scout's whole
  // fetch-error naming, because the body was read OUTSIDE the try/catch. "terminated" names no cause
  // and suggests no action; and an agent that reasons about half a page as if it were whole is worse
  // off than one that knows the page is incomplete.
  const { createServer } = await import('node:http');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: pjoin } = await import('node:path');

  // A server that promises a big body, sends a fraction, then destroys the socket mid-stream.
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'content-length': '100000' });
    res.write('<html><body>' + 'x'.repeat(1000));
    setTimeout(() => { try { res.socket.destroy(); } catch {} }, 30);
  });
  await new Promise((r) => srv.listen(0, r));
  const url = `http://127.0.0.1:${srv.address().port}/page`;

  const dir = mkdtempSync(pjoin(tmpdir(), 'scout-trunc-'));
  const { fetchUrl } = await import('../src/core.js');
  const saved = process.env.SCOUT_DB;
  process.env.SCOUT_DB = pjoin(dir, 'cache.db');
  try {
    let msg = '';
    try { await fetchUrl(url); assert.fail('a truncated download must not resolve as a whole page'); }
    catch (e) { msg = e.message; }

    assert.match(msg, /could not fetch/i, 'it goes through the error naming — not a bare throw');
    assert.match(msg, /incomplete|dropped|finished downloading/i, 'it says the page is INCOMPLETE, not just "terminated"');
    assert.doesNotMatch(msg, /^terminated$/, 'never the bare word Node hands up');

    // And the truncated page must NOT be in the cache — a half-page answered as whole forever is the
    // confident-wrong-answer this whole class is about.
    const { list } = await import('../src/core.js');
    assert.equal(list({ k: 50 }).pages.filter((p) => p.url === url).length, 0, 'a failed fetch caches nothing');
  } finally {
    if (saved === undefined) delete process.env.SCOUT_DB; else process.env.SCOUT_DB = saved;
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
