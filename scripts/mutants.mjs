// CAN THE TEST SUITE STILL FAIL?
//
// Every other gate here asks "is the code right". This one asks the question underneath it:
// IS ANYTHING STILL WATCHING. A suite that has quietly stopped covering a property goes green
// for exactly the same reason as a suite that is passing honestly, and there is no way to tell
// the two apart by looking at the green.
//
// It has happened across this kit more than once. anvil's Docker tests were SKIPPED for months
// — 11 pass, 0 fail, 9 skipped, green every run — while the tool was completely broken on
// Linux. lens's file walk swallowed .env files, and twenty green tests never saw it.
//
// So: break the code ON PURPOSE, in the exact places whose breakage would cost the most, and
// demand the suite goes RED. If it stays green, the canary is dead and this job fails — the
// test guarding that line has stopped guarding it, and you find out today rather than the
// morning after it mattered.
//
//   node scripts/mutants.mjs
//
// Each canary must have EXACTLY ONE anchor. An anchor that has drifted is a canary that
// silently stopped watching, so a missing or ambiguous anchor is a hard failure, never a skip.

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const CANARIES = [
  {
    why: 'the LONGEST <article> is the post — the others are teaser cards, and scout must not hand one back',
    file: 'src/extract.js',
    find: '  if (arts.length) return arts.sort((a, b) => b.length - a.length)[0];',
    into: '  if (arts.length) return arts[0];',
  },
  {
    why: 'a dead URL names its cause — "fetch failed" is three words that name nothing and suggest nothing',
    file: 'src/core.js',
    find: "      ENOTFOUND: 'no such host — check the domain, or you may be offline',",
    into: "      ENOTFOUND: 'fetch failed',",
  },
  {
    why: 'a READ must never bring the store into being — asking a question left a .scout/ behind',
    file: 'src/db.js',
    find: 'export const get = (sql, ...a) => { const d = open(false); return d ? d.prepare(sql).get(...a) : undefined; };',
    into: 'export const get = (sql, ...a) => { const d = open(true); return d ? d.prepare(sql).get(...a) : undefined; };',
  },
  {
    why: '`truncated` is a CLAIM about the content — a page cut in half must never say it is whole',
    file: 'src/core.js',
    find: '  let truncated = false;',
    into: '  let truncated = true;',
  },
  {
    why: '...and the cut must actually happen — a page that blows the budget is not a briefing',
    file: 'src/core.js',
    find: '    md = md.slice(0, max_tokens * 4) + ',
    into: '    md = md.slice(0, max_tokens * 400) + ',
  },
  {
    why: 'the cache is the whole point — `fresh` defaults to false, or every read goes back to the network',
    file: 'src/core.js',
    find: 'export async function fetchUrl(url, { fresh = false, max_tokens = 6000, raw = false, timeout = 20000 } = {}) {',
    into: 'export async function fetchUrl(url, { fresh = true, max_tokens = 6000, raw = false, timeout = 20000 } = {}) {',
  },
  {
    why: 'an HTML page without a doctype is still HTML — a stricter sniff hands an agent the raw markup',
    file: 'src/core.js',
    find: '  const isHtml = !binary && (/html|xml/i.test(r.contentType) || /^\\s*<(?:!doctype|html)/i.test(r.text));',
    into: '  const isHtml = !binary && (/html|xml/i.test(r.contentType) && /^\\s*<(?:!doctype|html)/i.test(r.text));',
  },
  {
    why: 'raw:true must return the ORIGINAL html — `raw && !isHtml` silently ignores the option on the pages you would use it for',
    file: 'src/core.js',
    find: '    : (raw || !isHtml ? r.text : htmlToMarkdown(r.text, r.finalUrl));',
    into: '    : (raw && !isHtml ? r.text : htmlToMarkdown(r.text, r.finalUrl));',
  },
  {
    why: 'a page CHANGED if it gained OR lost a line — `&&` reports "unchanged" for a pure addition or removal',
    file: 'src/core.js',
    find: '  return { changed: added > 0 || removed > 0, added, removed, was_lines: a.length, now_lines: b.length };',
    into: '  return { changed: added > 0 && removed > 0, added, removed, was_lines: a.length, now_lines: b.length };',
  },
  {
    why: 'snippet() is superlinear — unbounded, ONE oversized page hangs every search that touches it (142s at 4MB)',
    file: 'src/core.js',
    find: 'const SNIPPET_MAX = 64 * 1024; // bounds snippet() at ~30ms worst case; every real page is far below',
    into: 'const SNIPPET_MAX = Infinity; // bounds snippet() at ~30ms worst case; every real page is far below',
  },
  {
    why: 'a SAVE must not make a page VANISH — split apart, a search sees the page with NO FTS row and scout answers "0 hits across your reading"',
    file: 'src/db.js',
    find: '  if (_txDepth++ === 0) d.exec(\'BEGIN IMMEDIATE;\');',
    into: '  if (false) d.exec(\'BEGIN IMMEDIATE;\');',
  },
];

// spawnSync returns status:null when IT kills the child for exceeding the timeout — a TIMEOUT,
// not a test failure. Reading that as "the suite is already red" turns a slow suite into a broken
// one. Distinguish them: a suite that never finished has not answered, and a mutant that makes the
// suite hang has not been "killed". (Only iris is slow enough to hit this, but the bug was latent
// in every copy of this helper.)
const TIMEOUT_MS = 600_000;
const run = () => {
  const r = spawnSync('npm', ['test'], { encoding: 'utf8', timeout: TIMEOUT_MS });
  // A SKIPPED test cannot kill a canary — it did not run. So the skip count is not trivia here:
  // it is the difference between "nothing guards this line" and "the guard never got to look".
  const skipped = +(`${r.stdout || ''}${r.stderr || ''}`.match(/^\s*(?:ℹ|#)\s*skipped\s+(\d+)/m)?.[1] || 0);
  return { failed: r.status !== 0, timedOut: r.signal === 'SIGTERM' || r.error?.code === 'ETIMEDOUT', skipped };
};

// 🔑 AND IT MUST NOT RUN TWICE AT ONCE. This tool EDITS YOUR SOURCE IN PLACE, so two concurrent runs
// do not merely confuse each other — they can make a planted bug PERMANENT:
//
//     run B plants a mutation in core.js
//     run A reads core.js as its "original"      ← the original now CONTAINS B's bug
//     run B restores its own copy
//     run A restores ITS "original"              ← re-plants B's bug, and A believes it cleaned up
//
// The sabotage is now in your tree, no process is left to undo it, and the tool that put it there
// reports success. It is not theoretical: two overlapping runs turned this repo's suite red, and the
// only message was "THE SUITE IS ALREADY RED" — which names neither the file nor the line.
// An exclusive lock, taken BEFORE the baseline (a concurrent run poisons the baseline too).
const LOCK = new URL('../.mutants.lock', import.meta.url);
try {
  writeFileSync(LOCK, String(process.pid), { flag: 'wx' });   // wx = fail if it already exists
} catch {
  let holder = '?';
  try { holder = readFileSync(LOCK, 'utf8').trim(); } catch { /* raced with a clean exit */ }
  const alive = holder !== '?' && (() => { try { process.kill(+holder, 0); return true; } catch { return false; } })();
  if (alive) {
    console.error(`another mutants run (pid ${holder}) is already editing this source tree. `
      + 'Two at once can make a planted bug PERMANENT — see the note above. Wait for it, or kill it.');
    process.exit(1);
  }
  // The holder is gone (killed before it could clean up). Its restore-on-exit ran, so the tree is
  // sound; the lock is just litter. Take it.
  writeFileSync(LOCK, String(process.pid));
}
const dropLock = () => { try { unlinkSync(LOCK); } catch {} };
process.on('exit', dropLock);

// The baseline must be GREEN, or every canary "dies" for free and this job proves nothing.
console.log('baseline…');
const base = run();
if (base.timedOut) {
  console.error(`THE SUITE DID NOT FINISH within ${TIMEOUT_MS / 1000}s — a timeout, not a failure. `
    + 'Raise TIMEOUT_MS or speed up the suite; do not read a slow suite as a broken one.');
  process.exit(1);
}
if (base.failed) { console.error('THE SUITE IS ALREADY RED. Nothing can be proven from here.'); process.exit(1); }
// 🔑 A canary cannot be killed by a test that DID NOT RUN. If the baseline skipped tests, then any
// canary those tests guard will "survive" — and it will look exactly like a coverage hole, sending
// you to write a test that already exists instead of to the one-line fix (start Docker / install
// Chrome). Two different facts, two different fixes; they must not print the same sentence.
// This is anvil's cycle-13 lesson one layer up: in CI a skipped test is a FAILED test, so CI never
// sees this — it is the LOCAL run that lies, and the local run is where you do the work.
if (base.skipped) {
  console.log(`⚠ the baseline SKIPPED ${base.skipped} test(s) — those cannot kill a canary, because they `
    + 'do not run. A survivor below is far more likely to be a missing dependency than a missing test.');
}
console.log('baseline: green\n');

// 🔑 THE MUTATION IS WRITTEN INTO YOUR SOURCE FILE and undone once the suite has run. If this
// process dies in between — Ctrl-C, SIGTERM, a cancelled CI job, an OOM kill — the planted bug is
// LEFT IN YOUR TREE: a deliberately subtle one-character sabotage, sitting exactly where your real
// fix was, ready for the next `git add -A`. It is not hypothetical — a killed run left
// `raw && !isHtml` in scout's core.js, silently reverting a real fix, and the next mutants run said
// only "THE SUITE IS ALREADY RED", which names neither the file nor the line.
//
// A TOOL THAT PLANTS BUGS ON PURPOSE MUST BE THE ONE THING THAT ALWAYS CLEANS UP AFTER ITSELF.
// writeFileSync is synchronous, so it is safe in an exit handler.
let planted = null;                       // { file, orig } while a mutation is on disk
const restore = () => { if (planted) { writeFileSync(planted.file, planted.orig); planted = null; } };
process.on('exit', restore);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(sig, () => { restore(); process.exit(130); });
process.on('uncaughtException', (e) => { restore(); console.error(e); process.exit(1); });

let dead = 0;
for (const c of CANARIES) {
  const orig = readFileSync(c.file, 'utf8');
  const hits = orig.split(c.find).length - 1;
  if (hits !== 1) {
    console.error(`✗ ANCHOR DRIFTED in ${c.file}: found ${hits}×\n    ${c.find}\n  ` +
      'A canary whose anchor has moved is not watching anything. Re-point it.');
    dead++; continue;
  }
  planted = { file: c.file, orig };
  writeFileSync(c.file, orig.replace(c.find, c.into));
  const res = run();
  restore();

  // A timeout on a mutant is NOT a kill: a broken mutant can hang instead of failing fast.
  if (res.timedOut) {
    console.error(`✗ INCONCLUSIVE — the suite timed out with this broken, so we cannot say it was killed:\n    ${c.why}`);
    dead++;
  } else if (!res.failed) {
    console.error(`✗ SURVIVED — the suite went GREEN with this broken:\n    ${c.why}\n    ${c.file}`);
    console.error(res.skipped
      ? `  …but ${res.skipped} test(s) were SKIPPED. A test that did not run cannot kill a canary, so this\n`
        + '  is most likely a MISSING DEPENDENCY (docker down? no chrome?), not a missing test.\n'
        + '  Provide it and re-run — do not go writing a test that may already exist.'
      : '  Nothing is guarding that line any more.');
    dead++;
  } else {
    console.log(`✓ killed — ${c.why}`);
  }
}

if (dead) { console.error(`\n${dead} canary/canaries are not watching. The suite cannot prove what it claims.`); process.exit(1); }
console.log(`\nall ${CANARIES.length} canaries killed — the suite can still fail where it matters.`);
