// Seed the scout cache with a few curated "articles" so `scout serve` shows a
// real reading room without hitting the network. Deterministic (fixed dates).
//   SCOUT_DB=./.scout/cache.db node scripts/seed.js
import { save } from '../src/core.js';

// A tiny self-contained illustration (base64 SVG data-URI) so the reading room
// shows a rendered image; amber-on-transparent reads on both the paper & night themes.
const DIAGRAM_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 170" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="18" y="52" width="184" height="66" rx="10" fill="none" stroke="#e0a24e" stroke-width="2"/>
  <text x="110" y="82" text-anchor="middle" fill="#e0a24e" font-size="15" font-weight="600">raw HTML</text>
  <text x="110" y="104" text-anchor="middle" fill="#b0895a" font-size="12">~380 KB · all chrome</text>
  <path d="M214 85 H342" stroke="#e0a24e" stroke-width="2" marker-end="url(#a)"/>
  <text x="278" y="76" text-anchor="middle" fill="#e0a24e" font-size="12">scout</text>
  <rect x="358" y="52" width="184" height="66" rx="10" fill="#e0a24e" fill-opacity="0.14" stroke="#e0a24e" stroke-width="2"/>
  <text x="450" y="82" text-anchor="middle" fill="#e0a24e" font-size="15" font-weight="600">clean markdown</text>
  <text x="450" y="104" text-anchor="middle" fill="#b0895a" font-size="12">~40 KB · ~90% smaller</text>
  <defs><marker id="a" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#e0a24e"/></marker></defs>
</svg>`;
const DIAGRAM = 'data:image/svg+xml;base64,' + Buffer.from(DIAGRAM_SVG).toString('base64');

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
heavyweight SaaS for autonomous work. See also [zero dependencies](https://tools-for-agents.dev/zero-dependency-doctrine), and the [Model Context Protocol](https://modelcontextprotocol.io/spec) it all speaks.`,
    // 🔑 THE TWO LINKS ABOVE ARE ON PURPOSE: one to a page the library HAS (zero-dependency-doctrine
    // → a "read ↗" button, .ob-go) and one it does NOT (the MCP spec → a "read it" button,
    // .ob-go.new, styled in accent). The outbound panel renders both variants, and until there was
    // a link of each kind in the seed, one of the two states could never appear in a gate.
  },
  {
    url: 'https://tools-for-agents.dev/readability-lite',
    title: 'Readability-lite: HTML → clean markdown',
    description: 'How scout strips a page down to the article, with zero dependencies.',
    fetched_at: '2026-07-09T14:03:00.000Z',
    markdown: `# Readability-lite

A web page is mostly chrome: nav, ads, cookie banners, scripts. An agent that reads the
raw HTML pays for all of it in tokens. **scout** extracts just the article.

![How scout strips a page down to the article](${DIAGRAM})

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
    url: 'https://tools-for-agents.dev/token-budgets/a/very/long/unbroken/path/that/word-wrap/cannot/break/anywhere/at/all',
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

  // ── The wider reading ────────────────────────────────────────────────────────
  // The six pages above are the kit's own writing. These are the web an agent actually READ while
  // building it — real topics from real hosts, varied in length and age. They exist for two reasons:
  // a reading room seeded with a handful of same-host pages is a reading room that has never been
  // seen full, and a search that can never withhold is a "show more" button (`.sq-b`) that no gate
  // could ever render. With a couple of dozen pages, a common query overflows the first screen and
  // the widening control finally appears. Every one mentions "agents" so one search reaches them all.
  {
    url: 'https://sqlite.org/wal.html',
    title: 'Write-Ahead Logging',
    description: 'How WAL mode lets readers and a writer coexist — and what it does not do for two writers.',
    fetched_at: '2026-07-02T08:20:00.000Z',
    markdown: `# Write-Ahead Logging

In the default rollback journal, a writer blocks all readers and a reader blocks the writer. WAL
inverts this: the writer appends new pages to a separate log, and readers keep reading the last
committed snapshot from the main database. One writer and many readers proceed at once.

The catch every multi-agent tool learns the hard way: WAL does nothing for **two writers**. The
second writer to ask for the lock does not queue — by default it is told \`SQLITE_BUSY\` and gives
up immediately. On a store shared by several agents that is silent data loss. \`PRAGMA busy_timeout\`
is the fix: it makes the loser wait for the lock rather than fail, and a write that waits is a write
that lands.`,
  },
  {
    url: 'https://sqlite.org/fts5.html',
    title: 'SQLite FTS5 and the bm25 ranking function',
    description: 'Full-text search as a virtual table, and why bm25 returns lower-is-better scores.',
    fetched_at: '2026-07-02T10:05:00.000Z',
    markdown: `# FTS5

FTS5 is a virtual-table module that indexes text and answers \`MATCH\` queries. The built-in
\`bm25()\` function scores each hit — and its scores are **negative, lower is better**, which trips
up everyone who orders \`DESC\` the first time.

Two documents with the same term frequencies and length score identically. \`ORDER BY score\` alone
leaves such ties in whatever order the query plan yields, so a stable secondary key — the row's own
identity — is what keeps results from shuffling under an agent between one search and the next.`,
  },
  {
    url: 'https://modelcontextprotocol.io/specification',
    title: 'The Model Context Protocol',
    description: 'A JSON-RPC protocol for agents to discover and call tools over stdio.',
    fetched_at: '2026-07-03T14:40:00.000Z',
    markdown: `# Model Context Protocol

MCP is how an agent learns what a tool can do and then does it. The client sends \`initialize\`,
then \`tools/list\` to enumerate the callable surface, then \`tools/call\` to invoke one. Everything
is JSON-RPC 2.0, usually over stdio, so a tool is just a process that speaks the protocol.

The discipline that makes it work for many tools at once is honest annotations: a \`readOnlyHint\`
means an agent can call it freely, a \`destructiveHint\` means it should think first. A tool that
lies in its schema is worse than one that under-describes itself, because the agent trusts the
schema.`,
  },
  {
    url: 'https://ar.al/readability',
    title: 'Extracting the article from the page',
    description: 'Boilerplate removal: how to find the one block of prose in a sea of nav and script.',
    fetched_at: '2026-07-04T09:15:00.000Z',
    markdown: `# Readability

A modern web page is mostly not the article. Navigation, sidebars, cookie banners, share buttons
and analytics scripts routinely outweigh the prose ten to one. Readability is the craft of throwing
all of that away and keeping the part a person came to read.

The heuristics are unglamorous and effective: prefer \`<article>\` and \`<main>\`, strip \`<script>\`,
\`<style>\`, \`<nav>\` and \`<aside>\`, score blocks by text-to-markup ratio, and decode entities once.
For an agent the payoff is measured in tokens — the same page, ninety percent lighter, is ninety
percent more context left for thinking.`,
  },
  {
    url: 'https://www.anthropic.com/research/context-budgets',
    title: 'Why token budgets beat "just read it"',
    description: 'Reading whole files is O(everything). Reading just enough is a budget you control.',
    fetched_at: '2026-07-04T16:30:00.000Z',
    markdown: `# Token budgets

The naive way to give an agent context is to paste in whole files and whole pages. It works until
the window fills, and then it fails silently — the model quietly forgets the top of its own context.

A budget flips the default. Instead of "read everything and hope it fits," an agent asks for the
1,800 tokens that matter and leaves the other 60,000 on disk. Retrieval, surgical line ranges and
lighter markdown are all the same idea: spend the window on thinking, not on scrollback.`,
  },
  {
    url: 'https://docs.docker.com/engine/security/capabilities',
    title: 'Dropping Linux capabilities in a container',
    description: '--cap-drop ALL, --network none, and the smallest box you can still run code in.',
    fetched_at: '2026-07-05T11:00:00.000Z',
    markdown: `# Container capabilities

A container is not a sandbox by default — it starts with a generous set of Linux capabilities and a
network. To run untrusted code you take those away: \`--cap-drop ALL\` removes every privileged
operation, \`--network none\` cuts the socket, a memory cap and a pids limit stop a fork bomb, and a
hard timeout stops an infinite loop.

The surprising cost is reading your own files: \`--cap-drop ALL\` removes \`CAP_DAC_OVERRIDE\`, so a
container-root process cannot read a host directory it does not own. An agent that mounts a repo to
test against learns this the first time the read fails for a reason that has nothing to do with its
code.`,
  },
  {
    url: 'https://maggieappleton.com/networked-notes',
    title: 'Networked notes and the backlink',
    description: 'A note is worth more for what links to it than for what it says.',
    fetched_at: '2026-07-05T19:45:00.000Z',
    markdown: `# Networked notes

A folder of notes is a filing cabinet; a graph of notes is a second brain. The difference is the
link. When \`[[Note A]]\` points at \`[[Note B]]\`, B gains a *backlink* — a way to find A from B
without anyone filing it there. The graph draws itself as the links accumulate.

For an agent the graph is memory that survives the context window. The trick is that links can point
at notes that do not exist yet — a promise to write them later — and the moment the note is written
the link heals. A broken link is not an error; it is a to-do.`,
  },
  {
    url: 'https://www.win.tue.nl/~vanwijk/stm.pdf',
    title: 'Squarified treemaps',
    description: 'Laying out a treemap so the rectangles are close to square and easy to read.',
    fetched_at: '2026-07-06T08:10:00.000Z',
    markdown: `# Squarified treemaps

A treemap shows a hierarchy as nested rectangles whose area is proportional to a value. The naive
"slice and dice" layout produces long thin slivers that are impossible to compare. Squarification
greedily groups children so each rectangle stays close to a square, trading a little positional
meaning for a lot of legibility.

An agent's use for one is showing where a repo's mass actually is — which directory holds the tokens
it will spend reading. A label that runs off the bottom of the last tile, under a fixed footer, is
the kind of defect only a screenshot catches.`,
  },
  {
    url: 'https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum',
    title: 'WCAG 2.5.8: Target Size (Minimum)',
    description: 'The 24-by-24 CSS pixel rule for anything you tap — and its exceptions.',
    fetched_at: '2026-07-06T13:25:00.000Z',
    markdown: `# Target Size (Minimum)

A control you press with a finger should be at least 24 by 24 CSS pixels, or have that much spacing
around it. Below that, the miss rate climbs, and it climbs fastest for the people the rule exists
for. An agent that writes UI blind will happily ship a 16-pixel button; only a tool that looks at
the rendered page catches it.

The exceptions matter as much as the rule: an inline link inside a sentence is exempt, because its
size is set by the line-height of the prose around it, not by a designer's choice. A rule that fires
on every word in a paragraph is a rule nobody keeps.`,
  },
  {
    url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion',
    title: 'prefers-reduced-motion',
    description: 'A real setting a real audience uses — and what a page owes it.',
    fetched_at: '2026-07-07T07:50:00.000Z',
    markdown: `# prefers-reduced-motion

Some people get motion sick from the animations the rest of us do not notice. \`prefers-reduced-motion\`
is how their operating system tells your page to hold still, and honoring it is not optional polish —
it is the difference between usable and unusable for that audience.

For a tool that renders other pages, it has a second use: a screenshot taken mid-animation is a frame
nobody was meant to read, so grading it produces findings that change between runs. Emulating reduced
motion makes the picture the same picture twice — but only if the page under test actually answers the
query, which is a thing worth testing.`,
  },
  {
    url: 'https://blog.crisp.se/2013/09/wip-limits',
    title: 'Why WIP limits make a team faster',
    description: 'Starting less finishes more — the counterintuitive heart of kanban.',
    fetched_at: '2026-07-07T15:15:00.000Z',
    markdown: `# WIP limits

The instinct on a busy team is to start everything. Kanban's answer is the opposite: cap the work in
progress, and a column that hits its cap turns amber — a signal to *finish* something before starting
the next. Less started, more finished.

For a board that agents claim work from, the limit is also a coordination primitive. If every started
task is visible and the board goes red when the collective starts more than it finishes, no single
agent has to hold the whole plan in its head — the board holds it.`,
  },
  {
    url: 'https://tartarus.org/martin/PorterStemmer',
    title: 'The Porter stemming algorithm',
    description: 'Collapsing "connect", "connected" and "connection" to one searchable root.',
    fetched_at: '2026-07-08T10:40:00.000Z',
    markdown: `# Porter stemmer

Search that treats "connect" and "connection" as different words disappoints everyone. A stemmer
strips suffixes down to a common root so a query for one finds the others. Porter's 1980 algorithm is
a cascade of small rewrite rules — remove "-ing", turn "-ational" into "-ate" — and it is still the
default in most full-text engines because it is fast, deterministic and good enough.

An agent's search index leans on it without thinking. The reason a note about "connecting" surfaces
for a query of "connect" is a fifty-year-old pile of suffix rules quietly doing its job.`,
  },
  {
    url: 'https://en.wikipedia.org/wiki/Longest_common_subsequence',
    title: 'Longest common subsequence',
    description: 'The dynamic-programming core of every line diff — and its quadratic trap.',
    fetched_at: '2026-07-09T09:30:00.000Z',
    markdown: `# Longest common subsequence

Comparing two files line by line is an LCS problem: find the longest sequence of lines that appears in
both, in order, and everything else is an insertion or a deletion. The textbook solution fills an
\`n\` by \`m\` grid, one cell per pair of lines.

That grid is the trap. It is O(n×m) in both time and memory, so diffing two large outputs — say the
logs of two agent runs — can allocate gigabytes and take seconds. The fix is not a cleverer algorithm
but a cap: a diff a human reads is a few thousand lines at most, and past that you compare the head and
say the rest was truncated.`,
  },
  {
    url: 'https://nodejs.org/api/worker_threads.html',
    title: 'Node worker threads and Atomics',
    description: 'Real parallelism in Node, and the barrier that makes a race test actually race.',
    fetched_at: '2026-07-10T11:20:00.000Z',
    markdown: `# worker_threads

Node is single-threaded by default, which is fine until you want to *prove* something is safe under
real contention. \`worker_threads\` gives you actual OS threads sharing nothing but what you pass them,
and that is exactly what a concurrency test needs: many writers hitting one store at the same instant.

The subtlety is making them collide. Spawn the workers, let each signal it is ready, and only release
them together — a barrier. Without it the first worker finishes before the last starts, the race never
happens, and a green test tells you nothing. A concurrency test that does not collide is a light left
on over an empty road.`,
  },
  {
    url: 'https://www.w3.org/WAI/ARIA/apg/patterns/combobox',
    title: 'The ARIA combobox pattern',
    description: 'An input plus a listbox: arrow keys move the selection, and the options are not tabbable.',
    fetched_at: '2026-07-11T08:05:00.000Z',
    markdown: `# Combobox

A search box with a dropdown of results is a combobox, and ARIA has a precise pattern for it. Focus
stays in the input; the arrow keys move a highlight through the options via \`aria-activedescendant\`;
Enter opens the highlighted one. Crucially, the options are **not** in the tab order — you do not Tab
to an option, you arrow to it.

This is the pattern an agent gets wrong by making the result rows into buttons. A row you can Tab to is
the bug, not the fix: it breaks the arrow-key flow and floods the tab sequence. The right shape is
\`role="option"\` inside a \`role="listbox"\`, driven by the input above it.`,
  },
  {
    url: 'https://arxiv.org/abs/2005.11401',
    title: 'Retrieval-augmented generation',
    description: 'Give the model the right context at the start, not a bigger model.',
    fetched_at: '2026-07-12T14:10:00.000Z',
    markdown: `# Retrieval-augmented generation

RAG pairs a language model with a retriever: before the model answers, it pulls the passages most
relevant to the question and puts them in the prompt. The win is that the knowledge lives outside the
weights — you update it by editing a store, not by retraining.

For an agent with several stores — notes, reading, code, a team's memory — the interesting version is
*federated*: one query across all of them, interleaved into a single budgeted briefing. Used at the
start of a task it is the difference between an agent that already knows the context and one that
rediscovers it from scratch every session.`,
  },
  {
    url: 'https://apenwarr.ca/log/mtime-caching',
    title: 'mtime is a lie you can usually trust',
    description: 'Modification time as a cache key: cheap, standard, and occasionally wrong.',
    fetched_at: '2026-07-13T10:50:00.000Z',
    markdown: `# mtime caching

Make, rsync and every incremental indexer decide whether a file changed by comparing its modification
time against what they saw last. It is cheap — a \`stat\` — and almost always right, which is why it is
everywhere.

Almost. A \`touch\` bumps mtime without changing a byte, so an mtime-based tool re-does work for
nothing; worse, a checkout can set mtime to the checkout time rather than the commit time, and two edits
inside one clock tick can share an mtime and hide the second. For an agent's code index the honest
stance is to treat mtime as a fast path and let the reader ask for a rebuild when it doubts the answer.`,
  },
];

// Simulate the original page weight: real HTML carries ~7× the markdown in nav,
// scripts and boilerplate, so the reading room can show how much lighter it is.
let n = 0;
for (const a of articles) { save({ ...a, html_bytes: Math.round(a.markdown.length * (6 + (n % 3))) }); n++; }
console.log(`Seeded scout cache with ${n} articles.`);
