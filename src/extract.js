// scout — turn a messy HTML page into clean, readable markdown. Zero-dep,
// regex-based "readability-lite": drop scripts/chrome, keep the main article,
// convert the common block/inline elements, decode entities. Not a full DOM
// parser — but enough to give an agent a page's substance at a fraction of the
// tokens of the raw HTML.

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
  hellip: '…', copy: '©', reg: '®', trade: '™', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  laquo: '«', raquo: '»', deg: '°', euro: '€', pound: '£', cent: '¢', middot: '·', bull: '•' };

export function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      try { return Number.isFinite(n) ? String.fromCodePoint(n) : m; } catch { return m; }
    }
    return code in NAMED ? NAMED[code] : m;
  });
}

const stripTags = (t) => decodeEntities(String(t).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

export function extractTitle(html) {
  const og = html.match(/<meta[^>]+(?:property|name)=["']og:title["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']og:title["']/i);
  if (og) return decodeEntities(og[1]).trim();
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return t ? decodeEntities(t[1]).replace(/\s+/g, ' ').trim() : '';
}

export function extractDescription(html) {
  const d = html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i);
  return d ? decodeEntities(d[1]).trim() : '';
}

const resolveUrl = (href, base) => { try { return new URL(href, base).href; } catch { return href; } };

// Pick the densest main-content region: largest <article>, else <main>, else <body>.
function pickMain(html) {
  const arts = [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map((m) => m[1]);
  if (arts.length) return arts.sort((a, b) => b.length - a.length)[0];
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (main) return main[1];
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return body ? body[1] : html;
}

export function htmlToMarkdown(html, baseUrl = '') {
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|iframe|form)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  let m = pickMain(s).replace(/<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

  m = m
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (x, l, t) => `\n\n${'#'.repeat(+l)} ${stripTags(t)}\n\n`)
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (x, c) => `\n\n\`\`\`\n${decodeEntities(c.replace(/<[^>]+>/g, '')).replace(/\n+$/, '')}\n\`\`\`\n\n`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (x, c) => `\`${stripTags(c)}\``)
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (x, c) => `\n\n> ${stripTags(c)}\n\n`)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (x, c) => `\n- ${stripTags(c)}`)
    .replace(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/gi, (x, c) => { const t = stripTags(c); return t ? `\n\n*${t}*\n\n` : ''; })
    // keep images as markdown — the article's pictures are content, not chrome.
    // (skip 1×1 tracking pixels / spacers; resolve relative srcs to absolute.)
    .replace(/<img\b([^>]*?)\/?>/gi, (x, attrs) => {
      const src = ((attrs.match(/\ssrc=["']([^"']+)["']/i) || attrs.match(/\sdata-src=["']([^"']+)["']/i)) || [])[1];
      if (!src) return '';
      if (/\b(?:width|height)=["']?1["']?/i.test(attrs) || /(?:spacer|pixel|blank|1x1|tracking)/i.test(src)) return '';
      const alt = stripTags((attrs.match(/\salt=["']([^"']*)["']/i) || [])[1] || '');
      const abs = /^(?:data:|https?:)/i.test(src) ? src : resolveUrl(src, baseUrl);
      return `\n\n![${alt}](${abs})\n\n`;
    })
    .replace(/<a\b[^>]*\shref=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (x, href, t) => {
      const txt = stripTags(t);
      if (!txt) return '';
      if (/^(#|javascript:|mailto:)/i.test(href)) return txt;
      return `[${txt}](${resolveUrl(href, baseUrl)})`;
    })
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (x, _t, c) => `**${stripTags(c)}**`)
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (x, _t, c) => `*${stripTags(c)}*`)
    .replace(/<\/(p|div|section|article|ul|ol|table|tr|h[1-6])>/gi, '\n\n')
    .replace(/<br\b[^>]*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '');

  return decodeEntities(m)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Absolute, de-duplicated http(s) links with their anchor text, from raw HTML.
export function extractLinks(html, baseUrl = '', limit = 200) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*\shref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < limit) {
    if (/^(#|javascript:|mailto:|tel:)/i.test(m[1])) continue;
    const url = resolveUrl(m[1], baseUrl);
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ text: stripTags(m[2]).slice(0, 120), url });
  }
  return out;
}
