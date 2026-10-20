import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { fetchGitHubDownload } from '../src/download-provider.ts';
import { githubDownloadSchema } from '../src/read-contracts.ts';

const credential = {
  accessToken: 'private-fixture-token',
  accountId: 'account',
  membershipId: 'member',
  generation: 1,
  identity: { id: '1', login: 'owner' },
  scopes: ['repo'],
};
export const bytes = Buffer.from([0x50, 0x4b, 3, 4, 0, 255, 128, 42]);
const digest = createHash('sha256').update(bytes).digest('hex');
const operation = kind => ({ kind, owner: 'octocat', repo: 'private', id: 7 });
async function fixture(t) {
  const state = {
    kind: 'release.download',
    location: 'https://release-assets.githubusercontent.com/object?sig=private-signed-fixture',
    content: bytes,
    status: 200,
    denied: false,
    expired: false,
    oversized: false,
    changed: false,
    stall: false,
    secondRedirect: false,
    direct: false,
    metadataCount: 0,
    requests: [],
  };
  const server = createServer((req, res) => {
    state.requests.push({ path: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie });
    const metadata =
      !req.url.startsWith('/object') &&
      !req.url.endsWith('/zip') &&
      !req.url.endsWith('/logs') &&
      req.headers.accept !== 'application/octet-stream';
    if (metadata) {
      state.metadataCount++;
      res.writeHead(state.denied ? 403 : 200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 7,
          download_count: state.metadataCount,
          name: state.changed && state.metadataCount > 1 ? 'changed.bin' : 'private.bin',
          size: state.oversized ? 10485761 : bytes.length,
          size_in_bytes: state.oversized ? 10485761 : bytes.length,
          expired: state.expired,
          expires_at: state.expired ? '2000-01-01T00:00:00Z' : '2099-01-01T00:00:00Z',
          digest: `sha256:${digest}`,
          status: 'completed',
          run_attempt: 2,
        }),
      );
    } else if (req.url.startsWith('/object') || state.direct) {
      res.writeHead(
        state.secondRedirect ? 302 : state.status,
        state.secondRedirect
          ? { location: 'https://evil.test/poison' }
          : { 'content-type': 'application/octet-stream' },
      );
      if (state.stall) {
        res.flushHeaders();
        res.write(bytes);
      } else res.end(state.content);
    } else {
      res.writeHead(302, { location: state.location });
      res.end();
    }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const fetcher = (url, init) => {
    const parsed = new URL(url);
    return fetch(`http://127.0.0.1:${server.address().port}${parsed.pathname}${parsed.search}`, init);
  };
  return { state, run: kind => fetchGitHubDownload({ operation: operation(kind), credential, fetcher }) };
}

test('private release, artifact and pinned run-attempt archives download exact bytes over HTTP without forwarding credentials', async t => {
  const f = await fixture(t);
  for (const kind of ['release.download', 'actions.artifact-download', 'actions.run-logs-download']) {
    f.state.location =
      kind === 'release.download'
        ? 'https://release-assets.githubusercontent.com/object?sig=secret'
        : 'https://productionresultssa1.blob.core.windows.net/object?sig=secret';
    const result = await f.run(kind);
    assert.deepEqual(result.bytes, bytes);
    assert.equal(result.sha256, 'ff9fcdfa5cbd0e50f0fb0cd6ff0fa7d138bbfadc73a92fe7e68b6d949cc28e7c');
    assert.equal(
      result.filename,
      kind === 'release.download'
        ? 'private.bin'
        : kind === 'actions.artifact-download'
          ? 'private.bin.zip'
          : 'run-7-attempt-2-logs.zip',
    );
    assert.equal(JSON.stringify(result).includes('?sig='), false);
  }
  assert.ok(f.state.requests.some(r => r.path === '/repos/octocat/private/actions/runs/7/attempts/2/logs'));
  assert.equal(
    f.state.requests
      .filter(r => r.path.startsWith('/object'))
      .every(r => r.authorization === undefined && r.cookie === undefined),
    true,
  );
  f.state.direct = true;
  assert.deepEqual((await f.run('release.download')).bytes, bytes);
});

test('rejects redirect poison, credential injection and chains without disclosing signed URLs', async t => {
  const f = await fixture(t);
  for (const location of [
    'https://evil.test/object',
    'http://release-assets.githubusercontent.com/object',
    'https://release-assets.githubusercontent.com.evil.test/object',
    'https://user:pass@release-assets.githubusercontent.com/object',
    'https://release-assets.githubusercontent.com:8443/object',
    'https://release-assets.githubusercontent.com/object#fragment',
    'https://127.0.0.1/object',
    'https://release-assets.githubusercontent.com/object?token=private-fixture-token',
    'https://release-assets.githubusercontent.com/object?token=cHJpdmF0ZS1maXh0dXJlLXRva2Vu',
  ]) {
    f.state.location = location;
    await assert.rejects(f.run('release.download'), error => error.message === 'read-unavailable');
  }
  assert.equal(
    f.state.requests.some(r => r.path.startsWith('/object')),
    false,
  );
  f.state.location = 'https://release-assets.githubusercontent.com/object?sig=secret';
  f.state.secondRedirect = true;
  await assert.rejects(f.run('release.download'), /read-unavailable/);
  f.state.secondRedirect = false;
  assert.deepEqual((await f.run('release.download')).bytes, bytes);
  assert.equal(
    githubDownloadSchema.safeParse({ ...operation('release.download'), url: 'https://evil.test' }).success,
    false,
  );
});

test('fails closed on byte bounds, source changes, integrity errors, expiry and access loss', async t => {
  const f = await fixture(t);
  for (const [key, value, error] of [
    ['oversized', true, 'read-limit'],
    ['content', Buffer.alloc(10485761), 'read-limit'],
    ['content', Buffer.from('corrupt!'), 'read-unavailable'],
    ['denied', true, 'read-forbidden'],
    ['changed', true, 'read-unavailable'],
    ['status', 401, 'read-unavailable'],
    ['status', 403, 'read-unavailable'],
    ['status', 410, 'read-unavailable'],
  ]) {
    const original = f.state[key];
    f.state[key] = value;
    f.state.metadataCount = 0;
    await assert.rejects(f.run('release.download'), new RegExp(error));
    f.state[key] = original;
  }
  assert.deepEqual((await f.run('release.download')).bytes, bytes);
  f.state.expired = true;
  await assert.rejects(f.run('actions.artifact-download'), /read-unavailable/);
});

test('bounds stalled HTTP bodies and concurrent downloads', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  f.state.stall = true;
  const started = Date.now();
  const pending = Array.from({ length: 4 }, () => assert.rejects(f.run('release.download'), /read-unavailable/));
  await assert.rejects(f.run('release.download'), /read-limit/);
  await Promise.all(pending);
  assert.ok(Date.now() - started < 12000);
  f.state.stall = false;
  assert.deepEqual((await f.run('release.download')).bytes, bytes);
});
