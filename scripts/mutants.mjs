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

import { readFileSync, writeFileSync } from 'node:fs';
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
    find: '  const isHtml = /html|xml/i.test(r.contentType) || /^\\s*<(?:!doctype|html)/i.test(r.text);',
    into: '  const isHtml = /html|xml/i.test(r.contentType) && /^\\s*<(?:!doctype|html)/i.test(r.text);',
  },
  {
    why: 'raw:true must return the ORIGINAL html — `raw && !isHtml` silently ignores the option on the pages you would use it for',
    file: 'src/core.js',
    find: '  const markdown = raw || !isHtml ? r.text : htmlToMarkdown(r.text, r.finalUrl);',
    into: '  const markdown = raw && !isHtml ? r.text : htmlToMarkdown(r.text, r.finalUrl);',
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
  return { failed: r.status !== 0, timedOut: r.signal === 'SIGTERM' || r.error?.code === 'ETIMEDOUT' };
};

// The baseline must be GREEN, or every canary "dies" for free and this job proves nothing.
console.log('baseline…');
const base = run();
if (base.timedOut) {
  console.error(`THE SUITE DID NOT FINISH within ${TIMEOUT_MS / 1000}s — a timeout, not a failure. `
    + 'Raise TIMEOUT_MS or speed up the suite; do not read a slow suite as a broken one.');
  process.exit(1);
}
if (base.failed) { console.error('THE SUITE IS ALREADY RED. Nothing can be proven from here.'); process.exit(1); }
console.log('baseline: green\n');

let dead = 0;
for (const c of CANARIES) {
  const orig = readFileSync(c.file, 'utf8');
  const hits = orig.split(c.find).length - 1;
  if (hits !== 1) {
    console.error(`✗ ANCHOR DRIFTED in ${c.file}: found ${hits}×\n    ${c.find}\n  ` +
      'A canary whose anchor has moved is not watching anything. Re-point it.');
    dead++; continue;
  }
  writeFileSync(c.file, orig.replace(c.find, c.into));
  const res = run();
  writeFileSync(c.file, orig);

  // A timeout on a mutant is NOT a kill: a broken mutant can hang instead of failing fast.
  if (res.timedOut) {
    console.error(`✗ INCONCLUSIVE — the suite timed out with this broken, so we cannot say it was killed:\n    ${c.why}`);
    dead++;
  } else if (!res.failed) {
    console.error(`✗ SURVIVED — the suite went GREEN with this broken:\n    ${c.why}\n` +
      `    ${c.file}\n  Nothing is guarding that line any more.`);
    dead++;
  } else {
    console.log(`✓ killed — ${c.why}`);
  }
}

if (dead) { console.error(`\n${dead} canary/canaries are not watching. The suite cannot prove what it claims.`); process.exit(1); }
console.log(`\nall ${CANARIES.length} canaries killed — the suite can still fail where it matters.`);
