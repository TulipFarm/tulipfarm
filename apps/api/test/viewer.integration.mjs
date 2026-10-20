import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { encryptCredential } from '../../../packages/workspaces/src/credentials.ts';
import { getLastWorkspace } from '@tulipfarm/workspaces/store';
import {
  fixture,
  loadPlatformBaseline,
  markWorkspaceReady,
} from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { createAuth } from '../src/auth.ts';
import { protectBusinessRequests } from '../src/business.ts';
import { registerSecurity } from '../src/security.ts';
import { registerViewer } from '../src/viewer.ts';
import { registerWorkspaces } from '../src/workspaces.ts';

test(
  'viewer persists last workspace across sessions and rechecks membership, names, and deletion',
  { timeout: 60000 },
  async t => {
    const oldEnv = { ...process.env };
    const key = { keyId: 'viewer-test', key: randomBytes(32) };
    Object.assign(process.env, {
      NODE_ENV: 'test',
      WORKSPACE_STORAGE_CAPABILITY: 'isolated-v1',
      WORKSPACE_RUNTIME_KEY_ID: key.keyId,
      WORKSPACE_RUNTIME_KEY: key.key.toString('hex'),
      WEB_ORIGIN: 'http://localhost:5173',
      WEBSITE_ORIGIN: 'http://localhost:5100',
      BETTER_AUTH_URL: 'http://localhost:3001',
    });
    const db = await fixture();
    const pool = new Pool({ connectionString: db.connectionString, options: '-c search_path=app' });
    const apps = [];
    t.after(async () => {
      for (const app of apps) await app.close();
      await pool.end();
      await db.close();
      process.env = oldEnv;
    });
    await loadPlatformBaseline(db.platform);
    const first = await db.create();
    const second = await db.create();
    for (const [item, name, slug] of [
      [first, 'Northstar Studio', 'northstar'],
      [second, 'River Studio', 'river'],
    ]) {
      await markWorkspaceReady(db.platform, item.id);
      await db.platform.query(
        `UPDATE app.workspaces SET name=$2, slug=$3, soul_commit=$4,
      soul_bucket='fixture', soul_key='fixture', ready_at=now() WHERE id=$1`,
        [item.id, name, slug, 'a'.repeat(40)],
      );
      await db.platform.query('UPDATE app.workspace_storage SET runtime_credential=$2 WHERE workspace_id=$1', [
        item.id,
        encryptCredential(db.login(item), { workspaceId: item.id, generation: 1, capability: 'runtime' }, key),
      ]);
    }
    await db.platform.query(
      `INSERT INTO ${qualified(second.names.schema, 'tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`,
      [randomUUID(), first.userId],
    );
    const links = [];
    const auth = createAuth(
      pool,
      async ({ url }) => links.push(url),
      async () => {},
    );
    async function signIn(userId) {
      const { email } = (await pool.query('SELECT email FROM app.users WHERE id=$1', [userId])).rows[0];
      await auth.api.signInMagicLink({ headers: new Headers({ origin: process.env.WEB_ORIGIN }), body: { email } });
      const response = await auth.handler(new Request(links.pop()));
      assert.equal(response.status, 302);
      return response.headers
        .getSetCookie()
        .map(value => value.split(';')[0])
        .join('; ');
    }
    function replica() {
      const app = Fastify();
      registerSecurity(app, process.env.WEB_ORIGIN);
      app.register(
        async routes => {
          let runtime;
          registerViewer(routes, auth, userId => getLastWorkspace({ pool, runtime }, userId));
          routes.register(async business => {
            protectBusinessRequests(business);
            runtime = registerWorkspaces(
              business,
              { auth, pool },
              {
                connection: { withDeadline: async (_deadline, operation) => operation() },
                client: { workflow: { start: async () => {} } },
              },
            );
          });
        },
        { prefix: '/v1' },
      );
      apps.push(app);
      return app;
    }
    let app = replica();
    let cookie = await signIn(first.userId);
    const viewer = () => app.inject({ url: '/v1/viewer', headers: { origin: process.env.WEBSITE_ORIGIN, cookie } });
    const remember = (slug, headers = {}) =>
      app.inject({
        method: 'PUT',
        url: `/v1/workspaces/${slug}/last-used`,
        headers: { origin: process.env.WEB_ORIGIN, cookie, ...headers },
      });
    assert.equal((await viewer()).json().lastWorkspace, null);
    assert.equal((await remember('northstar', { cookie: '' })).statusCode, 401);
    assert.equal((await remember('northstar', { origin: process.env.WEBSITE_ORIGIN })).statusCode, 403);
    assert.equal((await remember('missing')).statusCode, 404);
    assert.equal((await app.inject({ url: '/v1/workspaces/northstar', headers: { cookie } })).statusCode, 200);
    assert.equal((await viewer()).json().lastWorkspace, null, 'Read-only requests never change the preference');
    assert.equal((await remember('northstar')).statusCode, 204);
    assert.deepEqual((await viewer()).json().lastWorkspace, { id: first.id, name: 'Northstar Studio' });
    assert.equal(
      (await pool.query('SELECT last_workspace_id FROM app.users WHERE id=$1', [first.userId])).rows[0]
        .last_workspace_id,
      first.id,
    );
    await app.close();
    app = replica();
    cookie = await signIn(first.userId);
    assert.equal(
      (await viewer()).json().appUrl,
      'http://localhost:5173/northstar',
      'A new session and API instance use the saved workspace',
    );
    assert.equal((await remember('river')).statusCode, 204);
    await pool.query("UPDATE app.workspaces SET name='River Renamed' WHERE id=$1", [second.id]);
    assert.deepEqual((await viewer()).json().lastWorkspace, { id: second.id, name: 'River Renamed' });
    const otherCookie = await signIn(second.userId);
    assert.equal(
      (await app.inject({ url: '/v1/viewer', headers: { cookie: otherCookie } })).json().lastWorkspace,
      null,
    );
    assert.equal((await remember('northstar', { cookie: otherCookie })).statusCode, 404);
    await db.platform.query(
      `UPDATE ${qualified(second.names.schema, 'tf_memberships')} SET removed_at=now() WHERE user_id=$1`,
      [first.userId],
    );
    assert.equal((await viewer()).json().lastWorkspace, null);
    assert.equal((await viewer()).json().appUrl, 'http://localhost:5173/');
    assert.equal((await remember('river')).statusCode, 404);
    assert.equal((await remember('northstar')).statusCode, 204);
    await pool.query(
      "UPDATE app.workspace_storage SET stage='unavailable', disabled_at=now(), disabled_operation_id=$2 WHERE workspace_id=$1",
      [first.id, randomUUID()],
    );
    assert.equal((await viewer()).json().lastWorkspace, null);
    assert.equal((await remember('river', { cookie: otherCookie })).statusCode, 204);
    await pool.query('DELETE FROM app.workspace_storage WHERE workspace_id=$1', [second.id]);
    await pool.query('DELETE FROM app.workspaces WHERE id=$1', [second.id]);
    assert.equal(
      (await pool.query('SELECT last_workspace_id FROM app.users WHERE id=$1', [second.userId])).rows[0]
        .last_workspace_id,
      null,
    );
    assert.equal(
      (await app.inject({ url: '/v1/viewer', headers: { cookie: otherCookie } })).json().lastWorkspace,
      null,
    );
    assert.equal((await viewer()).json().lastWorkspace, null);
    await auth.api.signOut({ headers: new Headers({ cookie }) });
    assert.equal((await viewer()).json().authenticated, false);
    assert.equal((await remember('river')).statusCode, 401);
  },
);
