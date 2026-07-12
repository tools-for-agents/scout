# 🧭 scout

[![ci](https://github.com/tools-for-agents/scout/actions/workflows/ci.yml/badge.svg)](https://github.com/tools-for-agents/scout/actions/workflows/ci.yml)

**The agent's web reader.**

Raw HTML is a terrible thing to feed a model — a 380 KB Wikipedia page is ~95k tokens of markup for a few KB of prose. `scout` fetches a URL and gives back **clean, readable markdown** (headings, links, code, lists — the substance, none of the chrome), typically **~90% smaller** than the HTML. Every page is **cached**, so re-reading is free and your **whole reading history is searchable**.

Part of [`tools-for-agents`](https://github.com/tools-for-agents). **Zero dependencies** — Node's built-in `fetch` + a regex "readability-lite" extractor + `node:sqlite` (FTS5). Pairs naturally with [`cortex`](../cortex): scout clips the web, cortex files it into your second brain.

---

## Why

| Without scout | With scout |
|---|---|
| Feed raw HTML to the model → ~95k tokens of `<div>`s | `scout_fetch` → ~5k tokens of clean prose |
| Re-fetch the same page every time you need it | Cached — re-reads are free (`--fresh` to bust) |
| "What did that article say about X?" → fetch again, re-read | `scout_search "X"` across everything you've read |
| No memory of what you've researched | A searchable reading history on disk |

## CLI

```bash
scout fetch https://en.wikipedia.org/wiki/Zettelkasten     # → clean markdown (cached)
scout fetch https://example.com/post --tokens 3000         # cap the returned size
scout fetch https://api.example.com/data.json --raw        # skip extraction
scout search "luhmann note linking" -k 5                   # search your reading history
scout links https://news.ycombinator.com --limit 30        # outbound links to crawl next
scout list | scout forget https://old.example.com | scout stats
scout serve                                                # → reading-room web view :7950
```

Cache location: `$SCOUT_DB` (default `./.scout/cache.db`).

## Reading room (`scout serve`)

![scout serve — the reading room: a shelf of cached pages and a clean serif reader](docs/web-view.png)

```bash
scout fetch https://en.wikipedia.org/wiki/Zettelkasten     # read a few pages…
scout serve                                                # → http://localhost:7950  (--port to change)
```

A calm, zero-dependency web view of everything scout has read — the same cache the agent recalls from:

- **Read a page from here** — paste a url into the reading room and scout fetches it, strips it to clean markdown, caches it, and opens it. Until now the web view could only ever show what the CLI or an agent had already fetched — it could read your library but never add to it. It writes to the same read-through cache the agent uses, so anything you read here is instantly searchable and instantly recallable by [`recall`](https://github.com/tools-for-agents/recall). Fetching is a `POST` (it reaches the network *and* writes), and only `http(s)` urls are accepted.
- **The shelf** — every cached page as a card (title, source, when it was read, `~token` size), newest first.
- **Filter by host** — chips above the shelf (each with a count) narrow the list to one site in a click — read everything you've kept from `en.wikipedia.org`, or just your own docs — and clear back to all.
- **Recent reads** — the articles you've opened surface as clickable chips above the shelf (remembered in the browser only, most-recent first); jump back to one in a click, or **clear ✕** to forget them.
- **Reading overview** — click the shelf stats for the whole history in the unit that actually matters: **tokens**. Reading those pages as raw HTML would have cost *~10.1k tokens*; scout kept *~1.5k* — so the headline is **~8.7k tokens saved (86% lighter)**, which is the entire pitch, finally shown. Underneath: **where you read** (top hosts, click one to narrow the shelf), **reading over time** (pages per day), and your **heaviest reads** — ranked by what the raw HTML *would* have cost (`~3.9k → ~550`), so the pages scout saved you the most on are named. Agents get the same digest from the `scout_overview` MCP tool.
- **Re-read it — and find out if it changed** — a cache you can't refresh is a fossil: `fresh` has always existed on `fetchUrl` and the reading room never set it, so a page you read a month ago was the page you'd read forever. **↻ re-read** pulls it again, and answers the question that actually matters — not *“here it is again”* but ***did it change***: *“Unchanged since you read it — what you took from it still holds”*, or *“This page **changed** — 3 lines added, 1 removed. What you took from it may be out of date.”* Reformatting isn't a change; only the words are. And **✕ forget** drops a page from the library (arms first, then fires), gone from the shelf *and* from search.
- **Where this page points** — every article now shows its outbound links, read straight from the clean markdown scout kept (**no network trip**). Each one says whether you've **already read it** — those open from your library — and the ones you haven't are **one click from being read**: scout fetches, strips and opens them, and the shelf grows. Following the web from inside your own reading room, an edge at a time.
- **Search** your whole reading history (FTS5 + bm25) with matched terms highlighted.
- **The reader** — clean, comfortable long-form: the extracted markdown rendered with real typographic hierarchy (including **images**), in a **paper** or **night** theme.
- **Keep it in cortex** — hit **🧠 → cortex** in the reader and the article becomes a note in your [second brain](https://github.com/tools-for-agents/cortex): the clean markdown, cited to the **original page** (an article's source is the web, not scout's copy of it) with a link back to the cached read alongside. This is the `scout fetch | cortex capture` loop the toolkit was designed around — read the web, keep what matters — finally one click. scout never writes: your browser POSTs to cortex's own `/api/capture` (point it elsewhere with `SCOUT_CORTEX_URL`).
- **Copy markdown** — one **⧉ copy markdown** button in the reader lifts the whole article's clean markdown to your clipboard — the same tokens an agent would get from `scout_fetch`, ready to paste into a note, a prompt, or [`cortex`](../cortex).
- **More from this site** — the foot of every article lists the other pages you've read from the **same host**, newest first, each a click away — so following a source you already trust is one hop, not a re-search.
- **Table of contents** — any article with a couple of headings gets a **☰ contents** button; open it for an outline of the page, click a heading to jump to that section, and the current section stays highlighted as you scroll.
- **Reading progress** — a slim bar across the top of the reader fills as you scroll, so you always know how far through a long piece you are.
- **Keyboard-accessible** — every control has a visible focus ring, the article cards open with Tab + Enter (not just the mouse), and icon controls carry aria-labels.
- Read-only and **cache-only** — the web view never touches the network; `/api/page` returns 404 for anything not already read.

Try the demo without a network fetch: `node scripts/seed.js` then `scout serve`.

## MCP server (for agents)

```jsonc
{
  "mcpServers": {
    "scout": { "command": "node", "args": ["/abs/path/to/scout/mcp/mcp-server.js"],
               "env": { "SCOUT_DB": "/abs/path/to/.scout/cache.db" } }
  }
}
```

### Tools

| Tool | Use it to… |
|---|---|
| `scout_fetch` | Read a web page as clean, token-budgeted markdown (cached; `fresh` to re-fetch). |
| `scout_search` | Search every page you've already read — ranked snippets, no re-fetch. |
| `scout_links` | Extract a page's outbound links (absolute URLs + text) to decide where to go next. |
| `scout_list` | Your recent reading history. |
| `scout_forget` | Drop a page from the cache. |
| `scout_stats` | Pages cached, bytes stored, last fetch. |

### The research loop (with cortex)

1. `scout_fetch` the page → clean markdown.
2. `scout_search` your history to connect it to what you've already read.
3. `cortex_capture` the useful parts into your second brain, then `cortex_write` distilled, `[[linked]]` notes.
4. Next time, `cortex_search` / `scout_search` recall it instead of fetching the web again.

## How it works

- **Fetch** uses Node's global `fetch` (follows redirects, 20 s timeout, a plain user-agent).
- **Extraction** is regex-based readability-lite: strip `<script>/<style>/<nav>/<footer>/…`, pick the densest `<article>`/`<main>`/`<body>` region, convert headings, links (resolved to absolute), **content images** (`<img>`/`<figure>` → markdown, tracking pixels dropped), code, lists, bold/italic, and decode HTML entities. Not a full DOM parse — but it reliably turns an article into readable prose at a fraction of the tokens.
- **Cache** is a `node:sqlite` table keyed by URL; the same URL returns instantly unless `fresh`. An FTS5 mirror makes the whole history searchable by **bm25**, filled to a token budget (≈4 chars/token) — the same discipline as [`lens`](../lens) and [`cortex`](../cortex).
- Non-HTML responses (JSON, plain text) are stored verbatim.

## The agent toolkit

`scout` is the **read the web** leg of **[tools-for-agents](https://tools-for-agents.github.io)** — an operating system for agents.
Seven zero-dependency, MCP-native tools that form one loop:

| | | |
|---|---|---|
| 🛰️ | [agent-hq](https://github.com/tools-for-agents/agent-hq) | coordinate — shared memory, a kanban agents claim work from, a registry, a cost ledger |
| 🔎 | [lens](https://github.com/tools-for-agents/lens) | read code — token-budgeted retrieval — search, outlines, surgical reads |
| ⚒ | [anvil](https://github.com/tools-for-agents/anvil) | run safely — a throwaway Docker sandbox: network off, capped, timed |
| 🧠 | [cortex](https://github.com/tools-for-agents/cortex) | remember — an Obsidian-compatible second brain, wikilinked |
| 🧭 | **scout** | **read the web** — a URL becomes clean, cached, searchable markdown |
| 🎯 | [recall](https://github.com/tools-for-agents/recall) | recall it all — one query across brain, team, reading and code |
| 👁 | [iris](https://github.com/tools-for-agents/iris) | see — look at what you built, before you claim it works |

**Reading this as an agent?** [`/llms.txt`](https://tools-for-agents.github.io/llms.txt) is the map, and
[`/tools.json`](https://tools-for-agents.github.io/tools.json) hands you all **67 MCP tools** — every name, every
description, every install command — in **one fetch**, without cloning anything.

MIT licensed.
