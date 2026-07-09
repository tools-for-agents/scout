// scout extraction tests — run with `node --test`. Pure functions, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToMarkdown, extractTitle, extractDescription, extractLinks, decodeEntities } from '../src/extract.js';

const PAGE = `<!doctype html><html><head>
  <title>Raw Title</title>
  <meta property="og:title" content="OG Title" />
  <meta name="description" content="A short blurb." />
  <style>.x{color:red}</style>
</head><body>
  <nav><a href="/home">Home</a></nav>
  <article>
    <h1>Hello World</h1>
    <p>Some <strong>bold</strong> and <em>italic</em> text with a
       <a href="/docs/page">relative link</a> and <a href="https://ext.com/a">external</a>.</p>
    <ul><li>one</li><li>two</li></ul>
    <pre>code block</pre>
    <script>alert('nope')</script>
  </article>
  <footer><a href="/legal">Legal</a></footer>
</body></html>`;

test('extractTitle prefers og:title over <title>', () => {
  assert.equal(extractTitle(PAGE), 'OG Title');
  assert.equal(extractTitle('<title>Only This</title>'), 'Only This');
});

test('extractDescription reads the meta description', () => {
  assert.equal(extractDescription(PAGE), 'A short blurb.');
});

test('htmlToMarkdown keeps content, drops scripts/styles/nav/footer', () => {
  const md = htmlToMarkdown(PAGE, 'https://site.com/post');
  assert.match(md, /# Hello World/);
  assert.match(md, /\*\*bold\*\*/);
  assert.match(md, /\*italic\*/);
  assert.match(md, /- one/);
  assert.match(md, /```\ncode block\n```/);
  assert.doesNotMatch(md, /alert|color:red|Legal|Home/); // chrome + scripts gone
});

test('htmlToMarkdown resolves relative links to absolute', () => {
  const md = htmlToMarkdown(PAGE, 'https://site.com/post');
  assert.match(md, /\[relative link\]\(https:\/\/site\.com\/docs\/page\)/);
  assert.match(md, /\[external\]\(https:\/\/ext\.com\/a\)/);
});

test('extractLinks returns absolute, de-duplicated http links with text', () => {
  const links = extractLinks(PAGE, 'https://site.com/post');
  const urls = links.map((l) => l.url);
  assert.ok(urls.includes('https://site.com/home'));
  assert.ok(urls.includes('https://ext.com/a'));
  assert.equal(new Set(urls).size, urls.length); // no dupes
  assert.ok(links.find((l) => l.url === 'https://ext.com/a').text === 'external');
});

test('decodeEntities decodes named and numeric entities', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#65; &#x42;'), 'a & b <c> A B');
  assert.equal(decodeEntities('&mdash;&hellip;'), '—…');
});
