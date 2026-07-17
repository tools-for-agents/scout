// scout ordering tests — a list ordered by a NON-UNIQUE column reorders on a tie, and scout's
// lists order by fetched_at, which is `new Date().toISOString()`: two pages fetched in the same
// millisecond tie. On a tie SQLite returns whatever the query plan yields, which tracks rowid —
// so `forget` a page and re-read it (a normal flow) and it gets a new rowid and silently changes
// position among its same-timestamp neighbours, though nothing about its recency changed. Every
// fetched_at ordering now tie-breaks on url (the primary key: unique, and stable across
// forget+refetch, which rowid is not). Run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const work = mkdtempSync(join(tmpdir(), 'scout-order-'));
process.env.SCOUT_DB = join(work, 'cache.db');
process.on('exit', () => { try { rmSync(work, { recursive: true, force: true }); } catch {} });

const { save, forget, library, list, related } = await import('../src/core.js');

const TIED = '2026-07-10T12:00:00.000Z';
const page = (u, t) => ({ url: u, title: t, markdown: `# ${t}\nshared word content`, fetched_at: TIED, md_bytes: 40, html_bytes: 200, status: 200 });

// three pages, all fetched in the same millisecond — the tie is the whole point
for (const [u, t] of [['https://x/a', 'Alpha'], ['https://x/b', 'Bravo'], ['https://x/c', 'Charlie']]) save(page(u, t));

const libOrder = () => library({ k: 10 }).pages.map((p) => p.title);

test('a list ordered by a tied timestamp is stable across forget + re-fetch', () => {
  const before = libOrder();
  assert.deepEqual(before, ['Alpha', 'Bravo', 'Charlie'], `the tie should order by url: got ${before}`);

  // the flow that used to reorder it: forget Bravo and read it again (a NEW rowid)
  forget('https://x/b');
  save(page('https://x/b', 'Bravo'));

  const after = libOrder();
  assert.deepEqual(after, before,
    `forget + re-read must not move a page whose recency did not change — was ${before}, now ${after}`);
});

test('re-fetching a page in place does not move it either', () => {
  // save() is an upsert; re-saving the middle page must leave the order untouched
  save(page('https://x/b', 'Bravo'));
  assert.deepEqual(libOrder(), ['Alpha', 'Bravo', 'Charlie']);
});

// The same guarantee for every list that orders by fetched_at, not just library().
test('list() is stable on tied timestamps too', () => {
  const listOrder = list({ k: 10 }).pages.map((p) => p.title);
  assert.deepEqual(listOrder, ['Alpha', 'Bravo', 'Charlie'], `list() tie-break: got ${listOrder}`);

  forget('https://x/a');
  save(page('https://x/a', 'Alpha'));
  assert.deepEqual(list({ k: 10 }).pages.map((p) => p.title), ['Alpha', 'Bravo', 'Charlie'],
    'list() must be stable across forget + re-fetch');
});

// related() (the "More from <host>" reads) sorts the same way — same-host, excluding the current
// page — so its two neighbours must come back in a stable order across a forget + re-fetch too.
test('related() is stable on tied timestamps', () => {
  const relOf = () => related('https://x/a', { k: 10 }).pages.map((p) => p.title);
  const before = relOf();
  assert.deepEqual(before, ['Bravo', 'Charlie'], `related() tie-break: got ${before}`);
  forget('https://x/b');
  save(page('https://x/b', 'Bravo'));
  assert.deepEqual(relOf(), before, `related() must be stable across forget + re-fetch, was ${before}`);
});
