# AGENTS.md — scout

🧭 **The agent's web reader.** Fetch a URL as clean, cached, searchable markdown (~90% smaller than the
HTML). Clip the web, then distil into cortex. CLI + reading-room web view + MCP.
Part of [tools-for-agents](https://github.com/tools-for-agents).

## Setup

```bash
node --version                                  # 22+ required. Nothing to install.
npm test                                        # = node --test
node src/cli.js fetch https://example.com
node src/cli.js serve --port 7950               # the reading room
npm run mcp                                     # the MCP server, stdio
```

**Zero runtime dependencies, and that is a hard rule.** No `dependencies` in `package.json`, ever — this tool
reimplements readability rather than pull one in. Node 22+ gives you `node:sqlite` and a test runner.

| Env | For |
|---|---|
| `SCOUT_DB` | the cache database — **always redirect this in tests** |
| `SCOUT_PORT` | serve port (default 7950) |
| `SCOUT_MAX_BYTES` | fetch size cap |
| `SCOUT_CORTEX_URL` | optional cortex link-up |

## The rules this repo is built on

**1. Only the picture is evidence.** Run [iris](https://github.com/tools-for-agents/iris) against any UI
change and *look at the shot* before saying it works. Audit `phone,tablet,desktop`, both themes, `--hover`.

**2. 🔑 A seeded gate is only reproducible from a CLEAN store.** `look-overview` passed locally and failed in
CI because a dev `.scout/cache.db` had **accumulated pages from earlier sessions** that crowded the seeded
page out of `heaviest` — the local run was auditing different data. Always seed into a fresh db:

```bash
SCOUT_DB=/tmp/fresh/cache.db node scripts/seed.js
SCOUT_DB=/tmp/fresh/cache.db node src/cli.js serve --port 7951
```

**3. Say `[hidden]` out loud.** `.toc-toggle[hidden]` still rendered because a `display:` rule beats the
`hidden` attribute — the CSS must say `.toc-toggle[hidden] { display: none }`. This exact defect has now bitten
four repos in this kit.

**4. Open the doors.** The overview, the TOC and the recent strip are all behind something. Drive the page
with `--pre` and look. Still unopened: `.ob-go`, `.sq-b`, `.rel-card`.

**5. A wrong answer in the costume of a right one is the worst bug.** A 404 page parsed as an article, a
redirect loop named as a page — if scout cannot honestly read something, it must say so rather than return
tidy markdown of nothing.

## Tests

`npm test` — `node --test`, **no test may be skipped**. Prefer a test that fails against the original code.

## CI

`test` · `mutants` · `look` · `look-reader` · `look-toc` · `look-overview` · `first-run` · `states` ·
`dead-api` · `slow-api` · `refused-write`

- **`mutants`** — every canary must die. Push and read CI.
- **`look*`** are iris gates, seeded first. They use `tools-for-agents/iris@main`, so an iris bug can redden
  this repo — and once did: a false-positive `clipped` on a CSS ellipsis. Fixing the eye made the gate honest.

## Commits

Lowercase, `area: what changed and why it mattered` — `core:`, `ui:`, `ci:`, `fix:`. Say what was actually
wrong, including what fooled you. The git log is this project's real documentation.
