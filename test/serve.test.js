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

const { save, search } = await import('../src/core.js');
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
