import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  claimAppName,
  promoteAppName,
  readCurrentAppRoute,
  setAppPublicName,
  createApp,
} from '../../src/store/index.ts';
import { connect, fixture, loadPlatformBaseline } from '../../../workspace-storage/test/integration/fixture.mjs';

test(
  'a public name belongs to one app and a renamed app never gives its old name away',
  { timeout: 120000 },
  async t => {
    const db = await fixture();
    let runtime;
    t.after(async () => {
      await runtime?.end();
      await db.close();
    });
    await loadPlatformBaseline(db.platform);
    for (const migration of ['0011_app_hostnames.sql', '0013_app_server_routes.sql'])
      await db.platform.query(
        await readFile(new URL(`../../../../apps/database/migrations/${migration}`, import.meta.url), 'utf8'),
      );
    const workspace = await db.create();
    runtime = await connect(db.login(workspace));
    const tx = { client: runtime, schema: workspace.names.schema };
    const created = await createApp(tx, {
      id: randomUUID(),
      kind: 'public',
      slug: 'orders',
      title: 'Orders',
      createdBy: workspace.membershipId,
    });
    const app = created.app;
    const claim = name => ({ name, workspaceId: workspace.id, appId: app.id });
    const rename = async name => {
      const claimed = await claimAppName(db.platform, claim(name));
      if (!claimed.ok) return claimed;
      const { edgeVersion } = await setAppPublicName(tx, app.id, name);
      await db.platform.query('BEGIN');
      const { retired } = await promoteAppName(db.platform, claim(name));
      await db.platform.query('COMMIT');
      return { ok: true, edgeVersion, retired };
    };
    const names = async () =>
      (await db.platform.query('SELECT name, state FROM app.app_hostnames ORDER BY name')).rows.map(row => [
        row.name,
        row.state,
      ]);

    assert.deepEqual(await rename('acme-orders'), { ok: true, edgeVersion: 1, retired: null });
    assert.deepEqual(await claimAppName(db.platform, claim('acme-orders')), { ok: true });
    assert.deepEqual(await rename('acme-orders'), { ok: true, edgeVersion: 1, retired: null });
    assert.deepEqual(await rename('acme-sales'), { ok: true, edgeVersion: 2, retired: 'acme-orders' });
    assert.deepEqual(await names(), [
      ['acme-orders', 'retired'],
      ['acme-sales', 'current'],
    ]);

    const other = { name: 'acme-sales', workspaceId: workspace.id, appId: randomUUID() };
    assert.equal((await claimAppName(db.platform, other)).failure.code, 'name-taken');
    assert.equal((await claimAppName(db.platform, { ...other, name: 'acme-orders' })).failure.code, 'name-taken');
    assert.equal((await claimAppName(db.platform, claim('acme-orders'))).failure.code, 'name-taken');

    const current = { workspaceId: workspace.id, appId: app.id };
    assert.equal(await readCurrentAppRoute(db.platform, 'acme-orders'), null);
    assert.equal(await readCurrentAppRoute(db.platform, 'acme-nobody'), null);
    assert.deepEqual(await readCurrentAppRoute(db.platform, 'acme-sales'), { ...current, route: null });
    await db.platform.query(
      "UPDATE app.app_hostnames SET kind = 'server', status = 'active', edge_version = 3 WHERE name = 'acme-sales'",
    );
    assert.deepEqual(await readCurrentAppRoute(db.platform, 'acme-sales'), {
      ...current,
      route: { name: 'acme-sales', kind: 'server', status: 'active', version: 3 },
    });
  },
);
