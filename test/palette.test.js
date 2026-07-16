// The palette, graded by the kit's OWN rules — run with `node --test`.
//
// iris grades a GAME's declared palette two ways: every role must be distinguishable from the others
// (`indistinct-roles`, a redmean distance against a tolerance), and text must clear contrastAA. Both
// questions apply to this stylesheet, and nothing was asking them — so the paper theme shipped two
// greys nobody could tell apart, and the spare one made the search placeholder unreadable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// WCAG's own formula, inline. A copy of a SPEC, not of a design system: relative luminance has one
// definition and does not drift, and reaching into another repo's copy would cross a boundary that
// does not exist in this checkout.
const lum = (hex) => {
  const n = parseInt(String(hex).replace('#', ''), 16);
  const ch = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// iris's own perceptual distance and tolerance (src/core.js `dist`, iris/tokens.json game.tolerance).
const HEX = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const dist = (a, b) => { const rb = (a[0] + b[0]) / 2, dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt((2 + rb / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rb) / 256) * db * db); };
const TOLERANCE = 30;

// 🔑 Read the REAL palette out of the page — a copy passes forever while the page drifts.
const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
// `--faint:var(--muted)` is an ALIAS, and resolves to whatever --muted is in that block.
const themeBlocks = () => {
  const night = page.slice(0, page.indexOf(':root[data-theme="paper"]'));
  const paper = page.slice(page.indexOf(':root[data-theme="paper"]'), page.indexOf('@media (prefers-color-scheme: light)'));
  return [night, paper];
};
const inkIn = (css, name) => {
  const m = css.match(new RegExp(`--${name}: *(#[0-9a-f]{3,8}|var\\(--[a-z-]+\\))`, 'i'));
  if (!m) return null;
  const v = m[1];
  return v.startsWith('var(') ? inkIn(css, v.slice(6, -1)) : v.toLowerCase();
};

const QUIET = ['muted', 'faint'];
const SURFACES = ['bg', 'surface', 'surface-2'];

// 🔑 THE RULE IS "IDENTICAL OR DISTINGUISHABLE" — the bug is CLOSE BUT NOT EQUAL.
// Two tokens with the same value are one token, said out loud: paper has no room for a third quiet
// grey (--muted is already 4.81:1 on --bg), so --faint IS --muted there, and the alias declares it.
// Two tokens 18.4 apart are a distinction nobody can see, and the spare one is only ever the twin
// that fails AA where the other passes. That is the shape this test refuses.
test('every quiet ink is either an honest alias or genuinely distinguishable — never a near-miss', () => {
  themeBlocks().forEach((css, t) => {
    const inks = QUIET.map((n) => [n, inkIn(css, n)]).filter(([, v]) => v);
    for (let i = 0; i < inks.length; i++) {
      for (let j = i + 1; j < inks.length; j++) {
        const d = dist(HEX(inks[i][1]), HEX(inks[j][1]));
        assert.ok(d === 0 || d >= TOLERANCE,
          `${['night', 'paper'][t]}: --${inks[i][0]} ${inks[i][1]} and --${inks[j][0]} ${inks[j][1]} are ${d.toFixed(1)} apart. `
          + `Either they are the SAME grey (say so: --faint:var(--muted)) or they are ${TOLERANCE}+ apart and someone can `
          + `see the difference. In between is a distinction nobody can see, and the spare one is the twin that fails AA.`);
      }
    }
  });
});

test('every quiet ink clears AA on every surface it can land on', () => {
  themeBlocks().forEach((css, t) => {
    for (const ink of QUIET) {
      const iv = inkIn(css, ink);
      if (!iv) continue;
      for (const surf of SURFACES) {
        const sv = inkIn(css, surf);
        if (!sv) continue;
        const r = contrast(iv, sv);
        assert.ok(r >= 4.5,
          `${['night', 'paper'][t]}: --${ink} ${iv} on --${surf} ${sv} is ${r.toFixed(2)}:1 — under the 4.5 this kit declares. `
          + `(The search placeholder sat at 4.35:1 on --bg this way, and the eye cannot report it: a placeholder is not a text node.)`);
      }
    }
  });
});
