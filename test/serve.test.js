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

test('re-read: the question is not "here it is again" but "did it change"', async () => {
  const { pageDiff } = await import('../src/core.js');

  // the diff is about meaning, not bytes: reformatting is not a change
  const same = pageDiff('# Title\n\nA line.\n', '# Title\n\n   A line.   \n\n');
  assert.equal(same.changed, false, 'whitespace and blank lines are not a change');

  const moved = pageDiff('# Title\n\nOld claim.\n', '# Title\n\nNew claim.\nAnd more.\n');
  assert.equal(moved.changed, true);
  assert.equal(moved.added, 2, 'two lines are new');
  assert.equal(moved.removed, 1, 'one is gone');

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
