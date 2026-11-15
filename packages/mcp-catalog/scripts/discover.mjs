// Lists servers added to the official MCP Registry in the last N days (default 8) under a company's own
// domain name, with a hosted URL, that the catalog doesn't have yet. A person checks each one is official.
// Usage: node scripts/discover.mjs [days]
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';

const days = Number(process.argv[2] ?? 8);
const since = new Date(Date.now() - days * 86_400_000).toISOString();
const folder = new URL('../apps/', import.meta.url);
const apps = readdirSync(folder)
  .filter(file => file.endsWith('.json'))
  .map(file => JSON.parse(readFileSync(new URL(file, folder), 'utf8')));
const known = new Set(apps.flatMap(app => [app.registryName, app.remote?.url].filter(Boolean)));
const community = /^(io\.github\.|io\.gitlab\.|ai\.smithery|com\.pulsemcp|dev\.mcpjam)/;

const found = [];
for (let cursor = ''; ;) {
  const query = new URLSearchParams({
    limit: '100',
    version: 'latest',
    updated_since: since,
    ...(cursor && { cursor }),
  });
  const response = await fetch(`https://registry.modelcontextprotocol.io/v0.1/servers?${query}`);
  if (!response.ok) throw new Error(`MCP Registry answered ${response.status}`);
  const page = await response.json();
  for (const { server } of page.servers) {
    const url = server.remotes?.[0]?.url;
    if (!url || community.test(server.name) || known.has(server.name) || known.has(url)) continue;
    found.push(`- \`${server.name}\` ${url}${server.description ? ` — ${server.description}` : ''}`);
  }
  cursor = page.metadata?.nextCursor;
  if (!cursor) break;
}
const shown = found.slice(0, 50);
const more = found.length > shown.length ? `\n…and ${found.length - shown.length} more.\n` : '';
const summary = found.length
  ? `## New in the MCP Registry (last ${days} days)\n\nAdd only well-known apps, after checking the app's maker publishes the server.\n\n${shown.join('\n')}\n${more}`
  : `No new hosted servers under company domains in the last ${days} days.\n`;
process.stdout.write(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
