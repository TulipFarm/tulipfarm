import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';

export const releaseTarget = { owner: 'octocat', repo: 'private', repositoryId: 42 };
export const releaseFields = {
  tagName: 'v1.0',
  targetCommitish: 'main',
  name: 'Version one',
  body: 'Reviewed notes',
  prerelease: false,
};
export const updatedAt = '2026-10-02T00:00:00Z';
export const binary = Buffer.from([0, 255, 128, 13, 10, 1, 2, 3]);
export const upload = {
  kind: 'release.asset-upload',
  ...releaseTarget,
  releaseId: 10,
  name: 'binary.bin',
  label: 'Exact binary',
  contentType: 'application/octet-stream',
  size: binary.length,
  sha256: createHash('sha256').update(binary).digest('hex'),
  content: binary.toString('base64'),
};
export const releaseOperations = [
  { kind: 'release.create', ...releaseTarget, ...releaseFields },
  {
    kind: 'release.update',
    ...releaseTarget,
    releaseId: 10,
    expectedUpdatedAt: updatedAt,
    ...releaseFields,
    name: 'Edited version',
  },
  {
    kind: 'release.publish',
    ...releaseTarget,
    releaseId: 10,
    expectedUpdatedAt: updatedAt,
    ...releaseFields,
    assetIds: [20],
  },
  { kind: 'release.delete', ...releaseTarget, releaseId: 10, expectedUpdatedAt: updatedAt, assetIds: [20] },
  upload,
  { kind: 'release.asset-update', ...releaseTarget, assetId: 20, name: 'renamed.bin', label: 'Renamed binary' },
  { kind: 'release.asset-delete', ...releaseTarget, assetId: 20 },
];
export async function releaseProviderFixture(nativeFetch = fetch) {
  const assets = new Map([
    [
      20,
      {
        id: 20,
        name: 'old.bin',
        label: 'Original binary',
        size: 8,
        content_type: 'application/octet-stream',
        state: 'uploaded',
        digest: `sha256:${upload.sha256}`,
      },
    ],
  ]);
  const releases = new Map([
    [
      10,
      {
        id: 10,
        tag_name: 'v1.0',
        target_commitish: 'main',
        name: 'Version one',
        body: 'Reviewed notes',
        draft: true,
        prerelease: false,
        updated_at: updatedAt,
        immutable: false,
        author: { id: 123 },
        assets: [{ id: 20 }],
      },
    ],
  ]);
  const state = {
    lose: false,
    status: null,
    malformed: false,
    secret: '',
    deny: false,
    outsideDeny: false,
    push: true,
    repositoryId: 42,
    afterEffect: null,
  };
  const effects = [],
    requests = [],
    bytes = new Map();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture'),
      path = url.pathname;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks),
      isUpload = request.method === 'POST' && path.endsWith('/assets');
    const body = raw.length && !isUpload ? JSON.parse(raw) : undefined;
    const entry = {
      method: request.method,
      path,
      ...(body ? { body } : {}),
      ...(isUpload
        ? {
            raw,
            contentType: request.headers['content-type'],
            size: Number(request.headers['content-length']),
            name: url.searchParams.get('name'),
            label: url.searchParams.get('label'),
          }
        : {}),
    };
    requests.push(entry);
    const reply = (value, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(status === 204 ? undefined : JSON.stringify(value));
    };
    if (request.method === 'GET') {
      if (path === '/repos/outside/source')
        return reply(
          { id: 777, full_name: 'outside/source', description: 'Private outside content' },
          state.outsideDeny ? 403 : 200,
        );
      if (state.deny) return reply({}, 403);
      if (path === '/repos/octocat/private')
        return reply({
          id: state.repositoryId,
          full_name: 'octocat/private',
          archived: false,
          permissions: { push: state.push },
        });
      if (path === '/repos/octocat/private/issues/7') return reply({ id: 70, number: 7 });
      if (path.endsWith('/releases')) return reply([...releases.values()]);
      if (path.endsWith('/assets') && !path.includes('/releases/assets/')) return reply([...assets.values()]);
      const id = Number(path.split('/').at(-1)),
        value = path.includes('/releases/assets/') ? assets.get(id) : releases.get(id);
      if (value && request.headers.accept === 'application/octet-stream') {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(binary);
        return;
      }
      return reply(value ?? {}, value ? 200 : 404);
    }
    if (state.status === 422) return reply({}, 422);
    let value,
      status = 200;
    const id = Number(path.split('/').at(-1));
    if (path === '/repos/octocat/private/issues/7/comments') {
      value = { id: 71 };
      status = 201;
    } else if (isUpload) {
      value = {
        id: 21,
        name: entry.name,
        label: entry.label,
        size: raw.length,
        content_type: entry.contentType,
        state: 'uploaded',
        digest: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
      };
      assets.set(21, value);
      bytes.set(21, raw);
      releases.get(10)?.assets.push({ id: 21 });
      status = 201;
    } else if (path.endsWith('/releases') && request.method === 'POST') {
      value = { id: 11, ...body, updated_at: updatedAt, immutable: false, author: { id: 123 }, assets: [] };
      releases.set(11, value);
      status = 201;
    } else if (path.includes('/releases/assets/')) {
      if (request.method === 'DELETE') {
        assets.delete(id);
        for (const release of releases.values()) release.assets = release.assets.filter(asset => asset.id !== id);
        status = 204;
        value = null;
      } else {
        value = { ...assets.get(id), ...body };
        assets.set(id, value);
      }
    } else if (path.includes('/releases/')) {
      if (request.method === 'DELETE') {
        for (const asset of releases.get(id)?.assets ?? []) assets.delete(asset.id);
        releases.delete(id);
        status = 204;
        value = null;
      } else {
        value = { ...releases.get(id), ...body, updated_at: '2026-10-02T00:00:01Z' };
        releases.set(id, value);
      }
    } else return reply({}, 404);
    effects.push(entry);
    await state.afterEffect?.(entry);
    if (state.lose) {
      response.destroy();
      return;
    }
    reply(state.malformed ? { secret: state.secret || 'malformed' } : value, state.status ?? status);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    state,
    effects,
    requests,
    releases,
    assets,
    bytes,
    fetcher: (url, init) => {
      const parsed = new URL(url);
      assert.equal(
        parsed.origin,
        init.method === 'POST' && parsed.pathname.endsWith('/assets')
          ? 'https://uploads.github.com'
          : 'https://api.github.com',
      );
      assert.equal(init.redirect, init.headers.Accept === 'application/octet-stream' ? 'manual' : 'error');
      return nativeFetch(`http://127.0.0.1:${server.address().port}${parsed.pathname}${parsed.search}`, init);
    },
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
