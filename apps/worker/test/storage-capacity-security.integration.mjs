import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Pool, escapeLiteral } from 'pg';
import { buildApp } from '../../api/src/app.ts';
import { createAuth } from '../../api/src/auth.ts';
import { readMigrations } from '../../database/src/migrations.ts';
import { startNativePostgres } from './capacity-native-postgres.mjs';
import {
  createCapacityTransport,
  installCapacityApplicationAccess,
  verifyCapacitySources,
} from './storage-capacity.integration.mjs';

test(
  'capacity identity grants recover real HTTP auth without bypassing security limits',
  {
    skip: process.env.STORAGE_CAPACITY_SECURITY_TEST !== '1',
    timeout: 60000,
  },
  async t => {
    const priorEnv = { ...process.env };
    const postgres = await startNativePostgres();
    const password = randomBytes(32).toString('hex');
    const admin = new Pool({
      connectionString: `postgresql://postgres:local-postgres@127.0.0.1:${postgres.port}/postgres`,
      options: '-c search_path=app',
      max: 1,
    });
    const owner = new Pool({
      connectionString: `postgresql://capacity_owner:${password}@127.0.0.1:${postgres.port}/capacity_security`,
      options: '-c search_path=app',
      max: 1,
    });
    const identityURL = `postgresql://tulipfarm:${password}@127.0.0.1:${postgres.port}/capacity_security`;
    const identity = new Pool({ connectionString: identityURL, options: '-c search_path=app', max: 1 });
    const transport = createCapacityTransport();
    const apps = [];
    t.after(async () => {
      transport.close();
      await Promise.all(apps.map(app => app.close()));
      await Promise.all([identity.end(), owner.end(), admin.end()]);
      await postgres.close();
      for (const key of Object.keys(process.env)) if (!(key in priorEnv)) delete process.env[key];
      Object.assign(process.env, priorEnv);
    });
    await verifyCapacitySources(transport, ['127.0.0.1']);
    await admin.query(
      `CREATE ROLE tulipfarm LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${escapeLiteral(password)}`,
    );
    await admin.query(`CREATE ROLE capacity_owner LOGIN CREATEROLE PASSWORD ${escapeLiteral(password)}`);
    await admin.query('CREATE DATABASE capacity_security OWNER capacity_owner');
    for (const migration of await readMigrations(fileURLToPath(new URL('../../database/migrations', import.meta.url))))
      await owner.query(migration.sql);
    await installCapacityApplicationAccess(owner);
    assert.equal(
      (
        await identity.query(
          "SELECT has_table_privilege(current_user, 'app.api_rate_limits', 'SELECT, INSERT, UPDATE, DELETE') AS allowed",
        )
      ).rows[0].allowed,
      true,
    );
    await assert.rejects(identity.query('SELECT migration_credential FROM app.workspace_storage'), { code: '42501' });
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: identityURL,
      WORKSPACE_STORAGE_CAPABILITY: 'disabled',
      API_PROXY_MODE: 'direct',
      WEB_ORIGIN: 'http://localhost:5173',
      BETTER_AUTH_URL: 'http://localhost:3001',
      BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
      TEMPORAL_ADDRESS: '127.0.0.1:7233',
      TEMPORAL_NAMESPACE: 'default',
    });
    for (const key of Object.keys(process.env)) if (/^(GOOGLE_|TURNSTILE_)/.test(key)) delete process.env[key];
    let link;
    const auth = createAuth(
      identity,
      async data => {
        link = data.url;
      },
      async () => {},
    );
    await auth.api.signInMagicLink({
      headers: new Headers({ origin: process.env.WEB_ORIGIN }),
      body: { email: 'capacity@example.com', name: 'Capacity' },
    });
    const verified = await auth.handler(new Request(link));
    const cookie = verified.headers
      .getSetCookie()
      .map(value => value.split(';')[0])
      .join('; ');
    assert.ok(cookie);
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    const apis = [];
    for (let index = 0; index < 2; index++) {
      const app = buildApp();
      apps.push(app);
      apis.push(await app.listen({ host: '127.0.0.1', port: 0 }));
    }
    const request = (replica, path = '/v1/auth/get-session') =>
      transport.request({
        api: apis[replica],
        path,
        localAddress: '127.0.0.1',
        headers: { cookie, origin: process.env.WEB_ORIGIN },
      });
    await owner.query('REVOKE ALL ON app.api_rate_limits FROM tulipfarm');
    const unavailable = await request(0);
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.data.error, 'abuse-protection-unavailable');
    await installCapacityApplicationAccess(owner);
    for (let index = 0; index < 120; index++) {
      const result = await request(index % 2);
      assert.equal(result.status, 200);
      assert.equal(result.data.user.id, session.user.id);
      assert.equal(result.headers['x-content-type-options'], 'nosniff');
    }
    const sharedLimit = await request(1);
    assert.equal(sharedLimit.status, 429);
    assert.equal(sharedLimit.data.error, 'rate-limit-exceeded');
    assert.ok(Number(sharedLimit.headers['retry-after']) > 0);
    for (let index = 0; index < 239; index++) assert.equal((await request(0, '/v1/auth/options')).status, 200);
    const generalLimit = await request(0, '/v1/auth/options');
    assert.equal(generalLimit.status, 429);
    assert.ok(Number(generalLimit.headers['retry-after']) > 0);
    assert.equal((await request(1, '/v1/auth/options')).status, 200);
    assert.equal((await request(0, '/v1/health/live')).status, 200);
  },
);

test(
  'all capacity source addresses bind as real loopback peers',
  {
    skip: process.env.STORAGE_CAPACITY_SOURCE_TEST !== '1',
    timeout: 30000,
  },
  async t => {
    const transport = createCapacityTransport();
    t.after(() => transport.close());
    await verifyCapacitySources(transport);
  },
);
