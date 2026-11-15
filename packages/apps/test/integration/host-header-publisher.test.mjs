import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { testAppPublisher } from '@tulipfarm/extensions/testing';
import { connect } from '../../../../apps/database/src/postgres.ts';
import { migrate } from '../../../../apps/database/src/migrations.ts';
import { hostHeaderPublisher } from '../../src/host-header-publisher.ts';

const signal = () => new AbortController().signal;
const database = `app_sites_${randomUUID().replaceAll('-', '')}`;
let admin, owner, runtime, workspaceId, createdRole;

function memoryStorage() {
  const objects = new Map();
  return {
    objects,
    async has(key) {
      return objects.has(key);
    },
    async put(key, body, file) {
      const chunks = [];
      for await (const chunk of body) chunks.push(chunk);
      objects.set(key, { bytes: Buffer.concat(chunks), contentType: file.contentType });
    },
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      return {
        body: (async function* () {
          yield object.bytes;
        })(),
        contentType: object.contentType,
        bytes: object.bytes.byteLength,
      };
    },
    async delete(key) {
      objects.delete(key);
    },
    async *list(prefix) {
      yield* [...objects.keys()].filter(key => key.startsWith(prefix)).toSorted();
    },
  };
}

async function text(object) {
  const chunks = [];
  for await (const chunk of object.body) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const page = (releaseId, path, body) => ({
  releaseId,
  files: [{ path, sha256: '0'.repeat(64), bytes: body.length, contentType: 'text/html; charset=utf-8' }],
  read: async function* () {
    yield new TextEncoder().encode(body);
  },
});

let claimed = 0;
async function claim(name = `menu-${++claimed}`) {
  await owner.query(
    `INSERT INTO app.app_hostnames (name, workspace_id, app_id, state) VALUES ($1, $2, $3, 'current')`,
    [name, workspaceId, randomUUID()],
  );
  return name;
}

before(async () => {
  assert.ok(process.env.TEST_ADMIN_DATABASE_URL, 'Set TEST_ADMIN_DATABASE_URL to a disposable local PostgreSQL server');
  admin = await connect(process.env.TEST_ADMIN_DATABASE_URL);
  createdRole = !(await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'tulipfarm'")).rowCount;
  if (createdRole) await admin.query('CREATE ROLE tulipfarm NOLOGIN');
  await admin.query(`CREATE DATABASE "${database}"`);
  const url = new URL(process.env.TEST_ADMIN_DATABASE_URL);
  url.pathname = `/${database}`;
  owner = await connect(url.href);
  await migrate(owner, fileURLToPath(new URL('../../../../apps/database/migrations/', import.meta.url)), []);
  runtime = await connect(url.href);
  await runtime.query('SET ROLE tulipfarm');
  const userId = randomUUID();
  workspaceId = randomUUID();
  await owner.query(
    `INSERT INTO app.users (id, name, email, email_verified) VALUES ($1, 'Ada', 'ada@example.test', true)`,
    [userId],
  );
  await owner.query(
    `INSERT INTO app.workspaces (id, request_id, created_by, name, creation_name, slug)
     VALUES ($1, $2, $3, 'Acme', 'Acme', 'acme')`,
    [workspaceId, randomUUID(), userId],
  );
});

after(async () => {
  await runtime?.end();
  await owner?.end();
  await admin?.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  if (createdRole) await admin?.query('DROP ROLE tulipfarm');
  await admin?.end();
});

testAppPublisher('host header publisher', () => ({
  publisher: hostHeaderPublisher({ sitesDomain: 'sites.example.test', storage: memoryStorage(), database: runtime }),
  name: () => claim(),
}));

test('serves the live release by Host header and refuses everything else', async () => {
  const publisher = hostHeaderPublisher({
    sitesDomain: 'Sites.Example.test',
    storage: memoryStorage(),
    database: runtime,
  });
  const release = randomUUID();
  const files = {
    'index.html': '<!doctype html><title>Menu</title>',
    'assets/app.js': 'console.log("menu");',
    'docs/index.html': '<h1>Docs</h1>',
    'my file.txt': 'spaced',
  };
  await publisher.stage(
    {
      releaseId: release,
      files: Object.entries(files).map(([path, body]) => ({
        path,
        sha256: '0'.repeat(64),
        bytes: body.length,
        contentType: path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
      })),
      read: async function* (file) {
        yield new TextEncoder().encode(files[file.path]);
      },
    },
    signal(),
  );
  const name = await claim('menu');
  await publisher.apply({ name, kind: 'static', releaseId: release, status: 'active', version: 1 }, signal());
  const serve = (host, path) => publisher.serve({ host, path }, signal());

  const home = await serve('Menu.Sites.Example.test:8443', '/');
  assert.equal(home.kind, 'file');
  assert.equal(home.object.contentType, 'text/html; charset=utf-8');
  assert.equal(await text(home.object), '<!doctype html><title>Menu</title>');
  const script = await serve('menu.sites.example.test', '/assets/app.js');
  assert.equal(script.object.contentType, 'text/javascript; charset=utf-8');
  assert.equal(await text(script.object), 'console.log("menu");');
  assert.equal(await text((await serve('menu.sites.example.test', '/docs/')).object), '<h1>Docs</h1>');
  assert.equal(await text((await serve('menu.sites.example.test.', '/my%20file.txt')).object), 'spaced');
  for (const [host, path] of [
    ['menu.sites.example.test', '/missing.js'],
    ['menu.sites.example.test', '/../index.html'],
    ['menu.sites.example.test', '/%2e%2e/index.html'],
    ['menu.sites.example.test', '/assets//app.js'],
    ['menu.sites.example.test', '/%E0%A4%A'],
    ['menu.sites.example.test', 'index.html'],
    ['menu.example.test', '/'],
    ['a.menu.sites.example.test', '/'],
    ['unclaimed.sites.example.test', '/'],
    ['www.sites.example.test', '/'],
  ])
    assert.deepEqual(await serve(host, path), { kind: 'not-found' }, `${host} ${path}`);

  assert.deepEqual(
    await publisher.apply({ name, kind: 'static', releaseId: release, status: 'paused', version: 2 }, signal()),
    {
      stored: { name, kind: 'static', releaseId: release, status: 'paused', version: 2 },
    },
  );
  assert.deepEqual(await serve('menu.sites.example.test', '/'), { kind: 'unavailable' });
  await publisher.apply({ name, kind: 'static', releaseId: release, status: 'disabled', version: 3 }, signal());
  assert.deepEqual(await serve('menu.sites.example.test', '/'), { kind: 'unavailable' });
  await publisher.apply({ name, kind: 'static', releaseId: null, status: 'active', version: 4 }, signal());
  assert.deepEqual(await serve('menu.sites.example.test', '/'), { kind: 'unavailable' });
  await publisher.apply({ name, kind: 'server', status: 'active', version: 5 }, signal());
  assert.deepEqual(await serve('menu.sites.example.test', '/'), { kind: 'unavailable' });
  await publisher.apply({ name, kind: 'static', releaseId: release, status: 'active', version: 6 }, signal());
  assert.equal((await serve('menu.sites.example.test', '/')).kind, 'file');

  await owner.query(`UPDATE app.app_hostnames SET state = 'retired', retired_at = now() WHERE name = $1`, [name]);
  assert.deepEqual(await serve('menu.sites.example.test', '/'), { kind: 'not-found' });
});

test('a removed name serves 404 and an unclaimed name is never routed', async () => {
  const publisher = hostHeaderPublisher({
    sitesDomain: 'sites.example.test',
    storage: memoryStorage(),
    database: runtime,
  });
  const release = randomUUID();
  await publisher.stage(page(release, 'index.html', 'hi'), signal());
  const name = await claim('orders');
  await publisher.apply({ name, kind: 'static', releaseId: release, status: 'active', version: 7 }, signal());
  assert.equal((await publisher.serve({ host: 'orders.sites.example.test', path: '/' }, signal())).kind, 'file');
  await publisher.remove({ name, version: 8 }, signal());
  assert.deepEqual(await publisher.serve({ host: 'orders.sites.example.test', path: '/' }, signal()), {
    kind: 'not-found',
  });
  assert.deepEqual(
    await publisher.apply({ name, kind: 'static', releaseId: release, status: 'active', version: 8 }, signal()),
    {
      stored: null,
    },
  );

  assert.deepEqual(
    await publisher.apply(
      { name: 'nobody-claimed', kind: 'static', releaseId: release, status: 'active', version: 1 },
      signal(),
    ),
    { stored: null },
  );
  const { rows } = await owner.query(
    `SELECT count(*)::int AS count FROM app.app_hostnames WHERE name = 'nobody-claimed'`,
  );
  assert.deepEqual(rows, [{ count: 0 }]);
});

test('stage refuses file paths that leave the release', async () => {
  const storage = memoryStorage();
  const publisher = hostHeaderPublisher({ sitesDomain: 'sites.example.test', storage, database: runtime });
  for (const path of ['../escape.html', '/index.html', 'a//b.js', 'a\\b.js', ''])
    await assert.rejects(publisher.stage(page(randomUUID(), path, 'x'), signal()), {
      message: `Release file path is not a relative path: ${path}`,
    });
  assert.equal(storage.objects.size, 0);
});
