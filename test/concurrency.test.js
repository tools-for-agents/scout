// scout concurrency test — save() writes the page row and its FTS row together inside a BEGIN
// IMMEDIATE transaction, and scout is written by more than one process: the CLI fetching a URL and
// the MCP server fetching another at the same time are two writers on the same cache. WAL does
// nothing for two writers; without PRAGMA busy_timeout the second fails INSTANTLY with SQLITE_BUSY
// (the same store shape lost 45 of 60 writes before it). scout already tests a save staying atomic
// to a concurrent READER (the VANISH canary); this tests two concurrent WRITERS, which nothing did
// — the cache could silently drop fetched pages under contention. Run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

const work = mkdtempSync(join(tmpdir(), 'scout-conc-'));
const dbPath = join(work, 'cache.db');
process.env.SCOUT_DB = dbPath;
process.on('exit', () => { try { rmSync(work, { recursive: true, force: true }); } catch {} });

const { library } = await import('../src/core.js');

// 12×12 = 144 distinct pages, saved in overlapping bursts. save()'s BEGIN IMMEDIATE holds the
// lock across three statements, so the overlap window is short — it takes this many rapid writes
// for two workers to reliably collide, which is exactly what makes the miss visible: at a lighter
// load the transactions serialised by luck and the missing busy_timeout hid.
const WORKERS = 12;
const PER_WORKER = 12;

const WORKER = `
  const { workerData, parentPort } = require('node:worker_threads');
  process.env.SCOUT_DB = workerData.dbPath;
  (async () => {
    const { save } = await import(${JSON.stringify(new URL('../src/core.js', import.meta.url).href)});
    parentPort.postMessage({ ready: true });
    await new Promise((r) => parentPort.once('message', r));   // barrier: all writers save together
    const errors = [];
    for (let i = 0; i < workerData.perWorker; i++) {
      const url = 'https://ex.com/w' + workerData.id + '/p' + i;
      try { save({ url, title: 'W' + workerData.id + ' P' + i, markdown: 'body zqx ' + i, html_bytes: 100 }); }
      catch (e) { errors.push(String(e && e.message || e)); }
    }
    parentPort.postMessage({ errors });
  })();
`;

test('two writers saving at once — every page lands and nobody crashes on the lock', async () => {
  const ws = Array.from({ length: WORKERS }, (_, id) =>
    new Worker(WORKER, { eval: true, workerData: { dbPath, perWorker: PER_WORKER, id } }));
  await Promise.all(ws.map((w) => new Promise((r) => w.once('message', r))));   // all ready
  const done = ws.map((w) => new Promise((r) => w.once('message', r)));
  ws.forEach((w) => w.postMessage('go'));                                        // release together
  const results = await Promise.all(done);
  await Promise.all(ws.map((w) => w.terminate()));

  const crashed = results.flatMap((r) => r.errors);
  assert.deepEqual(crashed, [], `no writer may crash on the lock — busy_timeout is what prevents it: ${JSON.stringify(crashed)}`);

  // every distinct URL is in the cache — WORKERS × PER_WORKER pages, none dropped
  const n = library({ k: 1000 }).pages.length;
  assert.equal(n, WORKERS * PER_WORKER, `all ${WORKERS * PER_WORKER} pages must be saved, found ${n}`);
});
