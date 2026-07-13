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
    <figure><img src="/img/diagram.png" alt="A diagram" /><figcaption>Fig 1.</figcaption></figure>
    <img src="https://track.example/pixel.gif" width="1" height="1" alt="" />
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

test('htmlToMarkdown keeps content images (relative → absolute) and drops tracking pixels', () => {
  const md = htmlToMarkdown(PAGE, 'https://site.com/post');
  assert.match(md, /!\[A diagram\]\(https:\/\/site\.com\/img\/diagram\.png\)/, 'the figure image is kept as markdown');
  assert.match(md, /\*Fig 1\.\*/, 'the figcaption is kept as an italic caption');
  assert.doesNotMatch(md, /pixel\.gif/, 'the 1×1 tracking pixel is dropped');
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

// A REAL PAGE HAS MORE THAN ONE <article>. A blog post sits among "related" teaser cards,
// each of them a perfectly valid <article> — so "find the article" is not a lookup, it is a
// CHOICE, and scout makes it by length. That choice is the difference between handing an
// agent the post it asked for and handing it a 12-word advert for a different post.
//
// Nothing pinned it. Mutation testing broke the comparator (b.length - a.length -> +) and
// the whole suite stayed green, which means scout could have started returning an arbitrary
// teaser card and every test in this file would still have passed.
test('a page of many <article>s: the longest one is the post, and that is what scout returns', () => {
  const page = `<!doctype html><html><head><title>Blog</title></head><body><main>
    <article><h2>Related: ten CSS tricks</h2><p>A teaser card.</p></article>
    <article><h2>Related: why we moved to Rust</h2><p>Another teaser card.</p></article>
    <article><h1>The Real Post</h1>
      <p>The body the reader actually came for, long and substantive, several sentences of
         genuine prose that an agent would need to answer any question about this page.</p>
      <p>A second paragraph, so that it is unambiguously the longest article here.</p>
    </article>
  </main></body></html>`;
  const md = htmlToMarkdown(page, 'https://site.com/post');
  assert.match(md, /The Real Post/, 'the post itself must come back');
  assert.match(md, /the reader actually came for/, 'and its body with it');
  assert.doesNotMatch(md, /ten CSS tricks/, 'a teaser card is not the page');
  assert.doesNotMatch(md, /moved to Rust/, 'nor is the other one');
});
