// Seed the scout cache with a few curated "articles" so `scout serve` shows a
// real reading room without hitting the network. Deterministic (fixed dates).
//   SCOUT_DB=./.scout/cache.db node scripts/seed.js
import { save } from '../src/core.js';

const articles = [
  {
    url: 'https://tools-for-agents.dev/the-all-agent-company',
    title: 'The all-agent company',
    description: 'What it means to run a software company where every employee is an agent, and humans only provide oversight.',
    fetched_at: '2026-07-08T09:12:00.000Z',
    markdown: `# The all-agent company

**tools-for-agents** is an experiment: a software company where every employee is an
agent, and the only humans in the loop provide oversight. Agents register, pick up
work from a shared board, and record durable decisions in a shared memory.

## The core loop

Every agent runs the same loop, backed by six zero-dependency tools:

1. **coordinate** — claim a task, message teammates, log spend.
2. **read code** — pull *just enough* context instead of whole files.
3. **run safely** — execute untrusted code in a throwaway sandbox.
4. **remember** — write durable notes into a second brain.
5. **read the web** — turn a URL into clean, cached markdown.
6. **recall** — one query across every store.

> If work is not visible on the board, ledger, or activity feed, it did not happen.

The bet is that *primitives an agent fully owns* — local, auditable, MCP-native — beat
heavyweight SaaS for autonomous work. See also [zero dependencies](https://tools-for-agents.dev/zero-dependency-doctrine).`,
  },
  {
    url: 'https://tools-for-agents.dev/readability-lite',
    title: 'Readability-lite: HTML → clean markdown',
    description: 'How scout strips a page down to the article, with zero dependencies.',
    fetched_at: '2026-07-09T14:03:00.000Z',
    markdown: `# Readability-lite

A web page is mostly chrome: nav, ads, cookie banners, scripts. An agent that reads the
raw HTML pays for all of it in tokens. **scout** extracts just the article.

## The pipeline

- Strip \`<script>\`, \`<style>\`, \`<nav>\`, \`<footer>\` and other non-content tags.
- Prefer the \`<article>\` or \`<main>\` region when present.
- Convert headings, lists, links, blockquotes and code to markdown.
- Decode HTML entities (\`&amp;\` → \`&\`, \`&#65;\` → \`A\`).

On a 380 KB Wikipedia page this yields ~40 KB of markdown — a **~90% reduction**. The
result is cached, so re-reading the same URL costs nothing and every page you've read
becomes full-text searchable.`,
  },
  {
    url: 'https://tools-for-agents.dev/token-budgets',
    title: 'Why token budgets beat "just read it"',
    description: 'Retrieval that respects a token budget is the difference between an agent that scales and one that stalls.',
    fetched_at: '2026-07-09T16:40:00.000Z',
    markdown: `# Why token budgets matter

The naive way to give an agent context is to read whole files and whole pages. It works
until the repo or the reading list grows — then every step drags the entire history along.

## Budgeted retrieval

Both **lens** (code) and **scout** (web) return results ranked by relevance and *filled up
to a token budget*. You ask for the 1,800 tokens that matter, not the 60,000 that don't.

    search("websocket reconnect backoff", { max_tokens: 1800 })

Ranking is FTS5 with **bm25**. The snippet is trimmed, the budget is honored, and the
agent keeps its working memory for thinking rather than for scrollback.`,
  },
  {
    url: 'https://en.wikipedia.org/wiki/Full-text_search',
    title: 'Full-text search (FTS5 & bm25)',
    description: 'A short primer on the ranking that powers scout and lens search.',
    fetched_at: '2026-07-10T08:15:00.000Z',
    markdown: `# Full-text search

Full-text search indexes the *words* of a document so you can find it by content, not
just by title. SQLite ships this as the **FTS5** extension — no server, no dependency.

## bm25 ranking

FTS5 ranks matches with **bm25**, a function that rewards rare query terms and dampens
the effect of very long documents. Lower scores are better matches. It is the same idea
behind classic search engines, available in a single embedded file.

## Why it fits agents

- Zero infrastructure: the index lives next to the data.
- Snippets with highlighted matches, for cheap previews.
- Deterministic and inspectable — you can read exactly why a result ranked where it did.`,
  },
  {
    url: 'https://modelcontextprotocol.io/introduction',
    title: 'The Model Context Protocol',
    description: 'MCP is the wire an agent uses to call tools over stdio JSON-RPC.',
    fetched_at: '2026-07-10T10:22:00.000Z',
    markdown: `# The Model Context Protocol

**MCP** is a small JSON-RPC protocol that lets a model call tools it did not ship with.
A server advertises a list of tools; the client calls them by name with typed arguments.

## Why every tools-for-agents tool ships one

Each tool — agent-hq, lens, anvil, cortex, scout, recall — exposes an MCP server over
stdio. That means any MCP-capable model can drive the whole toolkit without glue code.

- \`scout_fetch\` — read a URL as clean markdown.
- \`scout_search\` — search everything you've read.
- \`lens_search\` — ranked code snippets within a token budget.

The protocol is deliberately boring, which is what makes it composable.`,
  },
  {
    url: 'https://tools-for-agents.dev/zero-dependency-doctrine',
    title: 'The zero-dependency doctrine',
    description: 'Every tool in the kit runs on the Node standard library. Here is why that constraint pays off.',
    fetched_at: '2026-07-10T11:05:00.000Z',
    markdown: `# The zero-dependency doctrine

No runtime \`npm\` dependencies anywhere in the toolkit — Node standard library only:
\`node:http\`, the built-in \`node:sqlite\`, \`fetch\`, and Server-Sent Events.

## What the constraint buys

1. **Auditable.** You can read every line that runs. No transitive supply chain.
2. **Portable.** \`git clone\` and run. Docker builds never break on a missing wheel.
3. **Durable.** Nothing rots when a package is unpublished or a major version lands.

It is a hard constraint, not a preference. When a tool feels like it *needs* a library,
that is usually a signal the feature is too big — and the smaller version is the better one.`,
  },
];

// Simulate the original page weight: real HTML carries ~7× the markdown in nav,
// scripts and boilerplate, so the reading room can show how much lighter it is.
let n = 0;
for (const a of articles) { save({ ...a, html_bytes: Math.round(a.markdown.length * (6 + (n % 3))) }); n++; }
console.log(`Seeded scout cache with ${n} articles.`);
