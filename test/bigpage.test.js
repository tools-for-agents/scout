// scout oversized-page tests — an outlier gets its OWN cache. It was written into the shared
// serve.test.js corpus first, and it broke two unrelated tests: it became the "heaviest read",
// and it dragged the "~90% lighter" ratio down to 30%. Neither was a bug in scout, and neither
// was fixable by tuning the fixture — a page that is 20× the size of every other page IS an
// outlier, and a corpus that other tests compute STATISTICS over is the wrong place to put one.
// Run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const work = mkdtempSync(join(tmpdir(), 'scout-big-'));
process.env.SCOUT_DB = join(work, 'cache.db');
process.on('exit', () => { try { rmSync(work, { recursive: true, force: true }); } catch {} });

const { save, search } = await import('../src/core.js');

save({ url: 'https://ex.com/normal', title: 'A Normal Page', description: 'x',
  markdown: '# Normal\n\nA page about the zzhugetopic subject, at an ordinary size.',
  html_bytes: 4000, fetched_at: '2026-07-03T00:00:00.000Z' });

test('ONE oversized page must not hang every search that touches it', () => {
  // snippet() is superlinear in the size of the page it excerpts: 3ms at 16KB, 792ms at 256KB, and
  // 142 SECONDS at 4MB — while the MATCH that found the row costs 1ms. So one oversized page hung
  // every search whose term it contained: no error, no answer, just a dead call.
  //
  // And scout's OWN cap is what admits it: maxBytes() says a 5MB page is perfectly legal to fetch
  // and cache. The two limits were each chosen sensibly, on their own, and nobody ever asked them
  // about each other. 1MB here (10.7s unfixed) keeps the test quick, far past the 64KB bound.
  save({ url: 'https://ex.com/huge', title: 'A Huge Page', description: 'x',
    markdown: 'zzhugetopic lorem ipsum dolor sit amet '.repeat(Math.floor((1024 * 1024) / 39)),
    html_bytes: 12 * 1024 * 1024, fetched_at: '2026-07-03T00:00:00.000Z' });

  const t0 = Date.now();
  const res = search('zzhugetopic', { k: 5 });
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, `search over a 1MB page must stay bounded — took ${ms}ms (10.7s+ unfixed)`);

  const hit = res.results.find((r) => r.url === 'https://ex.com/huge');
  assert.ok(hit, 'and the page is still FOUND — bounding the excerpt must not drop the result');
  assert.equal(hit.oversized, true, 'an oversized page says so');
  assert.ok(hit.chars > 1e6, 'and reports its real size');
  assert.equal(hit.excerpt_is_match, true, 'instr() still found a REAL window around a REAL match');
  assert.match(hit.excerpt, /zzhugetopic/, 'so the excerpt actually contains the term');

  // A normal page is completely unaffected: still snippet()-highlighted, still unflagged.
  const normal = res.results.find((r) => r.url === 'https://ex.com/normal');
  assert.ok(normal, 'the normal page still matches the same query');
  assert.equal(normal.oversized, undefined, 'a normal page is not flagged oversized');
  assert.match(normal.excerpt, /⟦/, 'and still gets snippet() highlighting — behaviour is unchanged');
});
