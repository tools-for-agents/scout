#!/usr/bin/env node
// scout — MCP server (stdio JSON-RPC). The agent's window to the web: fetch a
// URL and get back clean, readable markdown instead of raw HTML; every page is
// cached so re-reads are free and your whole reading history is searchable.
// Pairs naturally with cortex — clip the web, then distil it into your brain.
import { createInterface } from 'node:readline';
import * as scout from '../src/core.js';

const PROTOCOL = '2024-11-05';

const tools = [
  {
    name: 'scout_fetch',
    description: 'Fetch a web page and get back clean, readable markdown (headings, links, code, lists) instead of raw HTML — far cheaper in tokens. The page is cached, so fetching the same URL again is free (pass fresh:true to bypass). Big pages are truncated to a token budget; use scout_search to find within them.',
    inputSchema: { type: 'object', properties: {
      url: { type: 'string', description: 'The URL to read' },
      fresh: { type: 'boolean', description: 'Bypass the cache and re-fetch' },
      max_tokens: { type: 'integer', description: 'Token budget for the returned markdown (default 6000)' },
      raw: { type: 'boolean', description: 'Return raw response text without readability extraction' },
    }, required: ['url'] },
    run: (a) => scout.fetchUrl(a.url, a),
  },
  {
    name: 'scout_search',
    description: 'Search across every page you have already fetched — ranked, token-budgeted snippets. Recall something you read earlier without re-fetching it.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string' },
      k: { type: 'integer', description: 'Max results (default 8)' },
      max_tokens: { type: 'integer', description: 'Token budget for snippets (default 1800)' },
    }, required: ['query'] },
    run: (a) => scout.search(a.query, a),
  },
  {
    name: 'scout_links',
    description: 'Extract the outbound links (absolute URLs + anchor text) from a page — use it to decide where to navigate or crawl next.',
    inputSchema: { type: 'object', properties: {
      url: { type: 'string' }, limit: { type: 'integer', description: 'Max links (default 100)' },
    }, required: ['url'] },
    run: (a) => scout.links(a.url, a),
  },
  {
    name: 'scout_list',
    description: 'List recently fetched pages (your reading history).',
    inputSchema: { type: 'object', properties: { k: { type: 'integer' } } },
    run: (a) => scout.list(a),
  },
  {
    name: 'scout_forget',
    description: 'Remove a page from the cache.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    run: (a) => scout.forget(a.url),
  },
  {
    name: 'scout_stats',
    description: 'Cache statistics: pages cached, bytes stored, last fetch.',
    inputSchema: { type: 'object', properties: {} },
    run: () => scout.stats(),
  },
  {
    name: 'scout_overview',
    description: 'A digest of everything scout has read: how many tokens the raw HTML would have cost vs the clean markdown kept '
      + '(and the tokens saved), the top hosts read from, reading volume per day, and the heaviest pages.',
    inputSchema: { type: 'object', properties: { top: { type: 'number', description: 'How many hosts / heaviest pages to return (default 8)' } } },
    run: (a) => scout.overview({ top: a.top }),
  },
];

// ── What each tool does to the world ───────────────────────────────────────────
// MCP tool annotations (spec 2025-11-25). The spec's defaults are PESSIMISTIC: with no
// annotations at all, every tool here — including the pure reads — is declared
// destructive and open-world, and a conformant client should warn before each call.
// You do not become safe by omission. You become safe by saying so.
//
//   readOnlyHint    the tool changes nothing        → the client can skip the confirmation
//   destructiveHint it may overwrite or delete      → the client should warn first
//   idempotentHint  calling twice changes no more   → safe to retry on failure
//   openWorldHint   it reaches, or returns content from, outside our trust boundary
//                   (the web; the output of arbitrary code) → scrutinise what comes back
const ANNOTATIONS = {
  scout_search: {"readOnlyHint": true, "openWorldHint": true},
  scout_links: {"readOnlyHint": true, "openWorldHint": true},
  scout_list: {"readOnlyHint": true, "openWorldHint": true},
  scout_overview: {"readOnlyHint": true, "openWorldHint": true},
  scout_stats: {"readOnlyHint": true, "openWorldHint": false},
  scout_fetch: {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": true},
  scout_forget: {"readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false},
};

const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize')
    return reply(id, { protocolVersion: PROTOCOL, capabilities: { tools: {} },
      serverInfo: { name: 'scout', version: '0.1.0' } });
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list')
    return reply(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, annotations: ANNOTATIONS[name] })) });
  if (method === 'tools/call') {
    const tool = toolMap[params?.name];
    if (!tool) return fail(id, -32602, `unknown tool: ${params?.name}`);
    // Every tool DECLARES its required arguments in inputSchema, and nothing enforced
    // them. `lens_search` with no query did not say "query is required" — it called
    // search(undefined) and died three layers down with
    //     Cannot read properties of undefined (reading 'match')
    // which is what a model got back, as if it were an answer. A schema that promises a
    // check nobody performs is worse than no schema: the client trusts it.
    const args = params?.arguments || {};
    const missing = (tool.inputSchema?.required || [])
      .filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
    if (missing.length) {
      const how = missing
        .map((k) => `"${k}"${tool.inputSchema.properties?.[k]?.description ? ` (${tool.inputSchema.properties[k].description})` : ''}`)
        .join(', ');
      return fail(id, -32602, `${tool.name}: missing required argument${missing.length > 1 ? 's' : ''} ${how}`);
    }
    // ...and the TYPES it declares, and the enums. Nothing enforced those either, and
    // unlike a missing argument they do not crash — they corrupt, quietly:
    //   kanban_create_task labels:"urgent"   → a task whose labels are the letters u,r,g…
    //   cortex_write title:{...}             → a note on disk called "[object Object]"
    //   lens_search k:"eight"                → silently ignored, and you never learn why
    // Wrong data written confidently is worse than an error, because nothing announces it.
    const props = tool.inputSchema?.properties || {};
    const kindOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
    const OK = {
      string: (v) => typeof v === 'string',
      number: (v) => typeof v === 'number' && Number.isFinite(v),
      integer: (v) => Number.isInteger(v),
      boolean: (v) => typeof v === 'boolean',
      array: (v) => Array.isArray(v),
      object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
    };
    const wrong = [];
    for (const [k, spec] of Object.entries(props)) {
      const v = args[k];
      if (v === undefined || v === null) continue;
      if (spec.type && OK[spec.type] && !OK[spec.type](v)) {
        wrong.push(`"${k}" must be ${spec.type}, got ${kindOf(v)}`);
      } else if (spec.enum && !spec.enum.includes(v)) {
        wrong.push(`"${k}" must be one of ${spec.enum.join(' | ')} — got ${JSON.stringify(v)}`);
      }
    }
    if (wrong.length) return fail(id, -32602, `${tool.name}: ${wrong.join('; ')}`);
    try {
      const result = await tool.run(args);
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } catch (err) {
      return reply(id, { content: [{ type: 'text', text: `error: ${err.message}` }], isError: true });
    }
  }
  if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  line = line.trim(); if (!line) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  handle(msg).catch((e) => { if (msg.id !== undefined) fail(msg.id, -32603, String(e)); });
});
process.stderr.write('scout MCP server ready\n');
