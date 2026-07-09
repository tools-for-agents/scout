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
];

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
    return reply(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  if (method === 'tools/call') {
    const tool = toolMap[params?.name];
    if (!tool) return fail(id, -32602, `unknown tool: ${params?.name}`);
    try {
      const result = await tool.run(params.arguments || {});
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
