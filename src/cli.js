#!/usr/bin/env node
// scout CLI — the agent's web reader from the shell.
//   scout fetch <url> [--fresh] [--tokens N] [--raw]
//   scout search "<query>" [-k 8] [--tokens 1800]
//   scout links <url> [--limit 100]
//   scout list [-k 25] | scout forget <url> | scout stats
//   scout serve [--port 7950]
import * as scout from './core.js';

const [, , cmd, ...rest] = process.argv;
// Tiny arg parser: value-flags vs booleans, so a flag's value isn't mistaken
// for the positional URL/query.
const VALUE = new Set(['--tokens', '--limit', '-k']);
const positionals = []; const flags = {};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === '-' || !a.startsWith('-')) positionals.push(a);
  else if (VALUE.has(a)) flags[a] = rest[++i];
  else flags[a] = true;
}
const flag = (n, d) => (flags[n] !== undefined ? flags[n] : d);
const has = (n) => flags[n] === true;
const arg = () => positionals[0];
const out = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));

try {
  if (cmd === 'fetch' || cmd === 'read') {
    const r = await scout.fetchUrl(arg(), { fresh: has('--fresh'), raw: has('--raw'),
      max_tokens: +flag('--tokens', 6000) });
    out(`▸ ${r.title || r.url}\n  ${r.final_url}  · ${r.from_cache ? 'cached' : 'fetched'} · ${r.md_bytes}B → ~${r.tokens}tok${r.truncated ? ' (truncated)' : ''}\n`);
    out(r.markdown);
  } else if (cmd === 'search') {
    const r = await scout.search(arg() || '', { k: +flag('-k', 8), max_tokens: +flag('--tokens', 1800) });
    for (const x of r.results) out(`\n▸ ${x.title}  score=${x.score}\n  ${x.url}\n  ${x.excerpt}`);
    out(`\n— ${r.count} hits across your reading, ~${r.tokens} tokens —`);
  } else if (cmd === 'links') {
    const r = await scout.links(arg(), { limit: +flag('--limit', 100) });
    out(`${r.count} links from ${r.final_url}\n`);
    for (const l of r.links) out(`  ${l.url}${l.text ? `  — ${l.text}` : ''}`);
  } else if (cmd === 'list') {
    out(scout.list({ k: +flag('-k', 25) }));
  } else if (cmd === 'forget') {
    out(scout.forget(arg()));
  } else if (cmd === 'stats') {
    out(scout.stats());
  } else if (cmd === 'serve') {
    const { serve } = await import('./server.js');
    serve({ port: +flag('--port', process.env.SCOUT_PORT || 7950) });
  } else {
    out(`scout — the agent's web reader (fetch → clean markdown → cached → searchable)

  scout fetch <url> [--fresh] [--tokens N] [--raw]   fetch & extract readable markdown (cached)
  scout search "<query>" [-k N] [--tokens N]         search everything you've read
  scout links <url> [--limit N]                      outbound links from a page
  scout list [-k N]                                  recently fetched pages
  scout forget <url> | scout stats
  scout serve [--port 7950]                          browsable reading-room web view

  Cache: $SCOUT_DB (default ./.scout/cache.db). Re-fetching a cached URL is free unless --fresh.`);
  }
} catch (e) {
  console.error('error:', e.message);
  process.exit(1);
}
