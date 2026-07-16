// scout — zero-dependency markdown → HTML. Extracted from index.html so it can be TESTED.
//
// 🔑 THIS RENDERS PAGES FROM THE OPEN WEB. Every other renderer in this kit is shown text that the
// kit itself wrote; this one is shown whatever a stranger's server sent back. That is the whole job,
// and it is the reason the two rules below are not paranoia.
//
// 1. THE HREF WAS ESCAPED TWICE, so every link with two query parameters was BROKEN.
//    inline() runs esc() over the whole line first — so by the time the link rule matches, `&` is
//    already `&amp;`. Escaping the captured href AGAIN made it `&amp;amp;`, and the browser resolves
//    that attribute to a URL with a literal "&amp;" in it:
//
//        [q](https://ex.com/search?q=a&lang=en&p=2)
//        a.href → https://ex.com/search?q=a&amp;lang=en&amp;p=2      (measured, in the real page)
//
//    The IMAGE rule right above it interpolates `src` raw and was correct all along — two branches,
//    written together, and only one of them escaped twice. That inconsistency is what gave it away.
//
// 2. ANY SCHEME WAS ALLOWED, so a fetched page could hand scout a `javascript:` link.
//    Measured: a saved page containing [click me](javascript:alert(document.domain)) rendered as a
//    live <a href="javascript:alert(document.domain)"> on scout's own origin — where the reading
//    history and the API live. It needs a click, and an agent following a link is a click. A reader
//    for untrusted content must decide what a URL is allowed to BE, so: http/https/mailto, or
//    nothing. A refused link keeps its TEXT — the reader still shows you what the page said, it
//    just will not hand you the trigger.

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// The href arrives ALREADY escaped (inline() esc'd the whole line), so this must not escape again —
// it only decides whether the scheme is one we are willing to make clickable.
const SAFE_SCHEME = /^(https?:|mailto:|[^a-z0-9+.-]|$)/i;   // absolute http(s)/mailto, or no scheme at all (relative)
export const safeHref = (href) => {
  const scheme = String(href).match(/^([a-z0-9+.-]+):/i);
  if (!scheme) return href;                       // relative — same origin, fine
  return SAFE_SCHEME.test(href) ? href : null;    // javascript:, data:, vbscript:, file: … → refused
};

export function renderMarkdown(md) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  let html = '', i = 0;
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => {      // images — before links (![…] contains […])
      const u = safeHref(src);
      return u === null ? `[${alt}]` : `<img class="ar-img" src="${u}" alt="${alt}" loading="lazy" />`;
    })
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, href) => {
      const u = safeHref(href);
      // a refused link is still TEXT: the page said it, so the reader shows it — without the trigger
      return u === null ? txt : `<a href="${u}" target="_blank" rel="noopener">${txt}</a>`;
    });
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    // fenced code
    if (/^```/.test(line)) {
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; html += `<pre><code>${esc(buf.join('\n'))}</code></pre>`; continue;
    }
    // indented code block (4 spaces / tab)
    if (/^( {4}|\t)/.test(line)) {
      const buf = [];
      while (i < lines.length && (/^( {4}|\t)/.test(lines[i]) || !lines[i].trim())) {
        if (!lines[i].trim() && !(lines[i + 1] && /^( {4}|\t)/.test(lines[i + 1]))) break;
        buf.push(lines[i++].replace(/^( {4}|\t)/, ''));
      }
      html += `<pre><code>${esc(buf.join('\n'))}</code></pre>`; continue;
    }
    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { const n = Math.min(3, h[1].length); html += `<h${n}>${inline(h[2])}</h${n}>`; i++; continue; }
    // hr
    if (/^(---+|\*\*\*+|___+)\s*$/.test(line)) { html += '<hr />'; i++; continue; }
    // blockquote
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      html += `<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`; continue;
    }
    // unordered list
    if (/^[-*+]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) buf.push(`<li>${inline(lines[i++].replace(/^[-*+]\s+/, ''))}</li>`);
      html += `<ul>${buf.join('')}</ul>`; continue;
    }
    // ordered list
    if (/^\d+\.\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) buf.push(`<li>${inline(lines[i++].replace(/^\d+\.\s+/, ''))}</li>`);
      html += `<ol>${buf.join('')}</ol>`; continue;
    }
    // paragraph (gather until blank / block start)
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|>\s?|[-*+]\s|\d+\.\s|```|( {4}|\t)|(---+|\*\*\*+|___+)\s*$)/.test(lines[i])) buf.push(lines[i++]);
    html += `<p>${inline(buf.join(' '))}</p>`;
  }
  return html;
}
