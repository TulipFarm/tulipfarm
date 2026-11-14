// Checks every hosted server in apps/*.json and records what it found:
// - `remote.checked` moves to today when the server answers.
// - `remote.unreachableSince` is set when it doesn't, and cleared when it answers again.
// - `remote.auth` is filled in when it is `unknown`. A different answer for a known value is only reported,
//   because a person chose it.
// Servers whose address differs per account (`remote.variables`) are skipped.
// Usage: node scripts/probe.mjs [app-id ...]
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

const folder = new URL('../apps/', import.meta.url);
const today = new Date().toISOString().slice(0, 10);
const only = new Set(process.argv.slice(2));
const initialize = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'tulipfarm-mcp-catalog', version: '1' },
  },
});

const request = async (url, init) => {
  try {
    return await fetch(url, { ...init, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
  } catch {
    return null;
  }
};

const protectedResource = async url => {
  const { origin, pathname } = new URL(url);
  for (const path of [`/.well-known/oauth-protected-resource${pathname}`, '/.well-known/oauth-protected-resource']) {
    const response = await request(`${origin}${path}`, { headers: { accept: 'application/json' } });
    if (response?.ok && (await response.json().catch(() => null))?.authorization_servers) return true;
  }
  // Servers written to the 2025-03-26 spec publish only authorization-server metadata.
  const legacy = await request(`${origin}/.well-known/oauth-authorization-server`, {
    headers: { accept: 'application/json' },
  });
  return Boolean(legacy?.ok && (await legacy.json().catch(() => null))?.authorization_endpoint);
};

/** @returns {Promise<'oauth' | 'api-key' | 'none' | 'unreachable'>} */
export const probe = async ({ url: template, transport }) => {
  const url = template.replaceAll('{key}', 'probe');
  const response =
    transport === 'sse'
      ? await request(url, { headers: { accept: 'text/event-stream' } })
      : await request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: initialize,
        });
  await response?.body?.cancel().catch(() => {});
  if (!response || [404, 410].includes(response.status) || response.status >= 500) return 'unreachable';
  if (response.status === 401 || response.status === 403) {
    const challenge = response.headers.get('www-authenticate') ?? '';
    return challenge.includes('resource_metadata') || (await protectedResource(url)) ? 'oauth' : 'api-key';
  }
  return response.ok ? 'none' : 'unreachable';
};

const notes = [];
const files = readdirSync(folder).filter(file => file.endsWith('.json'));
const queue = files.filter(file => !only.size || only.has(file.replace(/\.json$/, '')));
const work = async () => {
  for (let file = queue.shift(); file; file = queue.shift()) {
    const path = new URL(file, folder);
    const app = JSON.parse(readFileSync(path, 'utf8'));
    if (!app.remote || app.remote.variables) continue;
    const found = await probe(app.remote);
    const remote = { ...app.remote };
    if (found === 'unreachable') {
      remote.unreachableSince ??= today;
      notes.push(`- ${app.name}: couldn’t reach ${remote.url} (since ${remote.unreachableSince})`);
    } else {
      remote.checked = today;
      delete remote.unreachableSince;
      if (remote.auth === 'unknown') remote.auth = found;
      else if (remote.auth !== found && !(remote.auth === 'api-key' && found === 'none'))
        notes.push(`- ${app.name}: listed as ${remote.auth}, but the server answered like ${found}`);
    }
    writeFileSync(path, `${JSON.stringify({ ...app, remote }, null, 2)}\n`);
  }
};
await Promise.all(Array.from({ length: 8 }, work));

const summary = notes.length
  ? `## Needs a look\n\n${notes.sort().join('\n')}\n`
  : 'Every hosted server answered as listed.\n';
process.stdout.write(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
