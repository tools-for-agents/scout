// The renderer had never been tested: it lived inline in the page, and nothing in this repo rendered
// a line of markdown. It is also the ONE renderer in this kit that is shown text written by a
// stranger. Run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { renderMarkdown, safeHref } = await import('../public/markdown.js');

// What the BROWSER resolves an attribute to, which is the only thing that decides where a click goes.
const attrDecoded = (v) => String(v).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
const hrefOf = (html) => attrDecoded(html.match(/href="([^"]*)"/)?.[1] ?? '');
const srcOf = (html) => attrDecoded(html.match(/src="([^"]*)"/)?.[1] ?? '');

// 🔑 A LINK MUST POINT WHERE THE PAGE SAID. inline() escapes the whole line first, so by the time the
// link rule matches, `&` is already `&amp;` — and escaping the captured href AGAIN made `&amp;amp;`.
// The browser then resolves the attribute to a URL with a literal "&amp;" in it. Measured in the real
// page: [q](…?q=a&lang=en&p=2) → a.href = https://ex.com/search?q=a&amp;lang=en&amp;p=2. Every link
// with two query parameters was broken, in the tool whose job is reading the web.
test('a link points where the page said — even with two query parameters', () => {
  assert.equal(hrefOf(renderMarkdown('[q](https://ex.com/search?q=a&lang=en&p=2)')),
    'https://ex.com/search?q=a&lang=en&p=2', 'the & survives as an &, not as &amp;');
  assert.equal(hrefOf(renderMarkdown('[plain](https://ex.com/page)')), 'https://ex.com/page');
  // the image rule interpolated src raw and was right all along — the two must agree
  assert.equal(srcOf(renderMarkdown('![i](https://ex.com/i.png?w=1&h=2)')), 'https://ex.com/i.png?w=1&h=2');
});

// 🔑 AND THE SCHEME IS NOT THE PAGE'S CHOICE. scout renders what a stranger's server sent. Measured:
// a saved page containing [click me](javascript:alert(document.domain)) rendered a live
// <a href="javascript:…"> on scout's own origin — where the reading history and the API live.
test('a fetched page cannot hand you a javascript: link', () => {
  const js = renderMarkdown('[click me](javascript:alert(document.domain))');
  assert.ok(!/href=/.test(js), `no href at all for a javascript: url; got ${js}`);
  assert.match(js, /click me/, 'but the TEXT stays — the page said it, so the reader shows it');
  assert.ok(!/javascript:/.test(js.replace(/click me/, '')), 'and the url is not smuggled elsewhere');

  for (const bad of ['data:text/html,x', 'vbscript:msgbox(1)', 'file:///etc/passwd', 'JAVASCRIPT:alert(1)']) {
    assert.equal(safeHref(bad), null, `${bad} is refused`);
  }
  for (const ok of ['https://ex.com/a?b=1&c=2', 'http://ex.com', 'mailto:a@b.c', '/relative/path', '#anchor']) {
    assert.equal(safeHref(ok), ok, `${ok} is allowed`);
  }
});

// The renderer must never become an injection point for the markup it produces.
test('markup in a fetched page is text, not markup', () => {
  const h = renderMarkdown('A <script>alert(1)</script> and an "attr" & an amp.');
  assert.ok(!/<script>/.test(h), 'the script tag is escaped');
  assert.match(h, /&lt;script&gt;/, 'and shown as what it is');
  assert.match(h, /&amp; an amp/, 'a bare & is escaped exactly once');
});

// The ordinary shapes still render — the point is that links are SAFE, not that markdown stopped.
test('and it still renders markdown', () => {
  assert.match(renderMarkdown('# Title'), /<h1>Title<\/h1>/);
  assert.match(renderMarkdown('- a\n- b'), /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(renderMarkdown('1. a\n2. b'), /<ol><li>a<\/li><li>b<\/li><\/ol>/);
  assert.match(renderMarkdown('**bold**'), /<strong>bold<\/strong>/);
  assert.match(renderMarkdown('`code`'), /<code>code<\/code>/);
  assert.match(renderMarkdown('> quoted'), /<blockquote>.*quoted.*<\/blockquote>/);
  assert.match(renderMarkdown('```\nx = 1\n```'), /<pre><code>x = 1<\/code><\/pre>/);
  assert.match(renderMarkdown('a paragraph'), /<p>a paragraph<\/p>/);
  assert.match(renderMarkdown('[t](https://ex.com)'), /rel="noopener"/, 'and an outbound link still opens safely');
});
