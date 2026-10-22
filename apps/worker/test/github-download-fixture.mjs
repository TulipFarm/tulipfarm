import { createServer } from 'node:http';
import { once } from 'node:events';
import { githubChatFixture } from './github-read-fixture.mjs';

export const archive = Buffer.from([0x50, 0x4b, 3, 4, 0, 255, 128, 42]);
export async function githubDownloadFixture() {
  const originalFetch = globalThis.fetch;
  const f = await githubChatFixture();
  const state = { deny: false, expired: false, content: archive, delay: 0, requests: [] };
  const provider = createServer((req, res) => {
    state.requests.push({ path: req.url, authorization: req.headers.authorization });
    if (state.deny) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    if (req.url.startsWith('/object')) {
      res.writeHead(state.expired ? 403 : 200, { 'content-type': 'application/octet-stream' });
      setTimeout(() => res.end(state.content), state.delay);
      return;
    }
    if (req.url.endsWith('/zip') || req.url.endsWith('/logs') || req.headers.accept === 'application/octet-stream') {
      res.writeHead(302, {
        location: `https://${req.url.includes('/releases/') ? 'release-assets.githubusercontent.com' : 'productionresultssa1.blob.core.windows.net'}/object?sig=private-signed-fixture`,
      });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 7,
        download_count: state.requests.length,
        name: 'private.bin',
        size: archive.length,
        size_in_bytes: archive.length,
        expired: false,
        expires_at: '2099-01-01T00:00:00Z',
        status: 'completed',
        run_attempt: 2,
      }),
    );
  }).listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const local = (url, init) =>
    originalFetch(`http://127.0.0.1:${provider.address().port}${new URL(url).pathname}${new URL(url).search}`, init);
  f.setProvider(local);
  const modelFetch = globalThis.fetch;
  globalThis.fetch = (url, init) =>
    ['release-assets.githubusercontent.com', 'productionresultssa1.blob.core.windows.net'].includes(
      new URL(url).hostname,
    )
      ? local(url, init)
      : modelFetch(url, init);
  return {
    ...f,
    state,
    async close() {
      provider.closeAllConnections();
      await new Promise(resolve => provider.close(resolve));
      await f.close();
    },
  };
}

export function downloadAnswer(request) {
  const text = JSON.stringify(request);
  const path = [...text.matchAll(/\/v1\/workspaces\/[a-f0-9-]+\/github\/chats\/[a-f0-9-]+\/downloads\/[a-f0-9-]+/g)].at(
    -1,
  )?.[0];
  if (!path) throw new Error('No download link reached the model');
  return `[Download private archive](${path})`;
}
