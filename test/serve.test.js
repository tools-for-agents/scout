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
