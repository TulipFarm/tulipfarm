/* oxlint-disable tulipfarm/product-copy -- Hostnames and protocol paths, not application copy. */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';
import { buildPreviewGateway, previewFilePath, previewKeyOf } from '../src/app-preview.ts';

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

const enter = ticket => ({
  method: 'POST',
  url: '/__tulipfarm/preview/enter',
  headers: { host, 'content-type': 'application/x-www-form-urlencoded' },
  payload: `ticket=${ticket}`,
});
const asset = (url = '/', headers = {}) => ({
  url,
  headers: { host, cookie: '__Host-tf_preview=token-1', ...headers },
});

test('preview hosts are recognised by their key alone', () => {
  assert.equal(previewKeyOf(`${key.toUpperCase()}.Preview.TulipFarm.test:443`, 'preview.tulipfarm.test'), key);
  assert.equal(previewKeyOf('api.tulipfarm.test', 'preview.tulipfarm.test'), undefined);
  assert.equal(previewKeyOf('preview.tulipfarm.test', 'preview.tulipfarm.test'), undefined);
  assert.equal(previewKeyOf('www.preview.tulipfarm.test', 'preview.tulipfarm.test'), null);
  assert.equal(previewKeyOf(`x.${key}.preview.tulipfarm.test`, 'preview.tulipfarm.test'), null);
});

test('preview paths match the public edge', () => {
  assert.equal(previewFilePath('/'), 'index.html');
  assert.equal(previewFilePath('/docs/'), 'docs/index.html');
  assert.equal(previewFilePath('/a%20b.css'), 'a b.css');
  assert.equal(previewFilePath('/docs'), 'docs');
  assert.equal(previewFilePath('/%2e%2e/secret'), null);
  assert.equal(previewFilePath('/a//b'), null);
  assert.equal(previewFilePath('/%E0%A4%A'), null);
});

test('a ticket opens one preview session and cannot be used again', async t => {
  const { dependencies } = fakes();
  const gateway = buildPreviewGateway(dependencies);
  t.after(() => gateway.close());

  const first = await gateway.inject(enter('ticket-1'));
  assert.equal(first.statusCode, 200);
  assert.equal(
    first.headers['set-cookie'],
    '__Host-tf_preview=token-1; Path=/; Max-Age=43200; Secure; HttpOnly; SameSite=None; Partitioned',
  );
  assert.equal(first.headers['cache-control'], 'no-store');
  assert.match(first.headers['content-security-policy'], /frame-ancestors https:\/\/app\.tulipfarm\.test$/);
  assert.match(first.body, /fetch\("\/__tulipfarm\/preview\/check"/);
  assert.match(first.body, /"preview-blocked" }, "https:\/\/app\.tulipfarm\.test"/);

  const second = await gateway.inject(enter('ticket-1'));
  assert.equal(second.statusCode, 403);
  assert.equal(second.headers['set-cookie'], undefined);
  assert.match(second.body, /"preview-expired" }, "https:\/\/app\.tulipfarm\.test"/);
});

test('the preview serves the draft build without caching and stops when edit access is revoked', async t => {
  const { dependencies, state } = fakes();
  const gateway = buildPreviewGateway(dependencies);
  t.after(() => gateway.close());

  const page = await gateway.inject(asset('/'));
  assert.equal(page.statusCode, 200);
  assert.equal(page.body, html);
  assert.equal(page.headers['content-type'], 'text/html');
  assert.equal(page.headers['content-length'], '29');
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['content-security-policy'], `frame-ancestors ${shellOrigin}`);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['set-cookie'], undefined);

  assert.equal((await gateway.inject(asset('/missing.js'))).statusCode, 404);
  assert.equal((await gateway.inject({ url: '/', headers: { host } })).statusCode, 401);
  assert.equal((await gateway.inject(asset('/', { cookie: '__Host-tf_preview=other' }))).statusCode, 401);

  state.role = 'use';
  const revoked = await gateway.inject(asset('/'));
  assert.equal(revoked.statusCode, 403);
  assert.equal(revoked.headers['cache-control'], 'no-store');
  assert.equal(state.builds, 3);
});

test('a preview cannot install a service worker', async t => {
  const { dependencies, state } = fakes();
  const gateway = buildPreviewGateway(dependencies);
  t.after(() => gateway.close());

  const response = await gateway.inject(asset('/sw.js', { 'service-worker': 'script' }));
  assert.equal(response.statusCode, 403);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(state.builds, 0);
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
