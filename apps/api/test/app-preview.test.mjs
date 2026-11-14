/* oxlint-disable tulipfarm/product-copy -- Hostnames and protocol paths, not application copy. */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';

process.env.ANTHROPIC_API_KEY ??= 'test-key';

const key = 'abcdefghijklmnopqrstuvwxyz';
const host = `${key}.preview.tulipfarm.test`;
const shellOrigin = 'https://app.tulipfarm.test';
const session = { workspaceId: '11111111-1111-4111-8111-111111111111', appId: 'a', membershipId: 'm' };
const html = '<!doctype html><h1>Draft</h1>';
const sha = 'a'.repeat(64);
const manifest = JSON.stringify([
  { path: 'index.html', sha256: sha, bytes: Buffer.byteLength(html), contentType: 'text/html' },
]);

function fakes() {
  const state = { tickets: new Set(['ticket-1']), role: 'edit', builds: 0 };
  return {
    state,
    dependencies: {
      domain: 'preview.tulipfarm.test',
      shellOrigin,
      async redeem(previewKey, ticket) {
        if (previewKey !== key || !state.tickets.delete(ticket)) return null;
        return { token: 'token-1' };
      },
      session: async (previewKey, token) => (previewKey === key && token === 'token-1' ? session : null),
      enabled: async () => true,
      async build() {
        state.builds += 1;
        if (state.role !== 'edit')
          return { ok: false, failure: { code: 'forbidden', message: 'App edit is required' } };
        return { ok: true, build: { buildId: 'b1', manifestKey: 'manifests/b1.json' } };
      },
      object: async objectKey =>
        objectKey === 'manifests/b1.json'
          ? Readable.from([manifest])
          : objectKey === `blobs/${sha}`
            ? Readable.from([html])
            : null,
    },
  };
}

const asset = (url = '/', headers = {}) => ({
  url,
  headers: { host, cookie: '__Host-tf_preview=token-1', ...headers },
});

test('the API never answers on a preview host', async t => {
  const { dependencies } = fakes();
  const app = buildApp({ agentModel: null, previewGateway: dependencies });
  t.after(() => app.close());

  const health = await app.inject({ url: '/v1/health', headers: { host } });
  assert.equal(health.statusCode, 401);
  assert.equal(health.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(health.headers['x-frame-options'], undefined);
  assert.equal(health.headers['access-control-allow-origin'], undefined);

  const preview = await app.inject(asset('/'));
  assert.equal(preview.body, html);

  const stray = await app.inject({ url: '/', headers: { host: `www.preview.tulipfarm.test` } });
  assert.equal(stray.statusCode, 404);
  assert.equal(stray.headers['cache-control'], 'no-store');

  const api = await app.inject({ url: '/v1/health', headers: { host: 'api.tulipfarm.test' } });
  assert.notEqual(api.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(api.headers['x-frame-options'], 'DENY');
});

test('a preview domain under the app sites domain still reaches the preview', async t => {
  const env = {
    TULIPFARM_OBJECT_STORAGE_APPS_BUCKET: 'apps',
    TULIPFARM_OBJECT_STORAGE_REGION: 'auto',
    TULIPFARM_APP_SITES_DOMAIN: 'apps.example.test',
  };
  const saved = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]));
  Object.assign(process.env, env);
  const { dependencies } = fakes();
  const app = buildApp({ agentModel: null, previewGateway: { ...dependencies, domain: 'drafts.apps.example.test' } });
  for (const [name, value] of Object.entries(saved))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  t.after(() => app.close());

  const preview = await app.inject(asset('/', { host: `${key}.drafts.apps.example.test` }));
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.body, html);
});
