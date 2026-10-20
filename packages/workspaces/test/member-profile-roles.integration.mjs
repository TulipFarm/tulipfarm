import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { escapeIdentifier } from 'pg';
import {
  fixture,
  connect,
  denied,
  loadPlatformBaseline,
  markWorkspaceReady,
  seedPlatformUser,
} from '../../workspace-storage/test/integration/fixture.mjs';
import { provisionTableRegistry } from '@tulipfarm/workspaces/table-registry';
import { memberProfileSource } from '@tulipfarm/workspaces/member-profiles';

test('profile reads remain scoped with distinct application and workspace owners', { timeout: 45000 }, async () => {
  const db = await fixture();
  const appOwner = `profile_owner_${randomUUID().replaceAll('-', '')}`;
  const registry = {
    capability: 'authoring',
    role: `profile_reader_${randomUUID().replaceAll('-', '')}`,
    password: randomBytes(32).toString('hex'),
  };
  const roles = [];
  let client;
  try {
    await db.platform.query(`CREATE ROLE ${escapeIdentifier(appOwner)} NOLOGIN`);
    roles.push(appOwner);
    await db.platform
      .query(`GRANT ${escapeIdentifier(appOwner)} TO ${escapeIdentifier(db.owner)} WITH INHERIT TRUE, SET TRUE;
      ALTER SCHEMA app OWNER TO ${escapeIdentifier(appOwner)};
      DROP TABLE app.accounts`);
    const database = escapeIdentifier(new URL(db.connectionString).pathname.slice(1));
    await db.platform.query(`GRANT CREATE ON DATABASE ${database} TO ${escapeIdentifier(appOwner)}`);
    await db.platform.query(`SET ROLE ${escapeIdentifier(appOwner)}`);
    try {
      await loadPlatformBaseline(db.platform);
    } finally {
      await db.platform.query('RESET ROLE');
      await db.platform.query(`REVOKE CREATE ON DATABASE ${database} FROM ${escapeIdentifier(appOwner)}`);
    }
    const workspace = await db.create();
    await markWorkspaceReady(db.platform, workspace.id);
    await provisionTableRegistry(db.platform, registry);
    roles.push(registry.role);
    const url = new URL(db.connectionString);
    url.username = registry.role;
    url.password = registry.password;
    client = await connect(url.href);
    const source = memberProfileSource(client);
    const stranger = randomUUID();
    await seedPlatformUser(db.platform, { id: stranger, name: 'Private outsider', email: `${stranger}@example.test` });
    const profiles = await source.read(workspace.id, [workspace.userId, stranger]);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].id, workspace.userId);
    assert.deepEqual(Object.keys(profiles[0]).sort(), ['email', 'id', 'image', 'name', 'revision']);
    assert.deepEqual(await source.read(workspace.id, [stranger]), []);
    await assert.rejects(source.read(randomUUID(), [workspace.userId]), /member-profiles-unavailable/);
    for (const relation of ['users', 'accounts', 'sessions', 'member_profile_outbox'])
      await denied(client, `SELECT * FROM app.${relation}`);
    await denied(client, `SELECT * FROM "${workspace.names.schema}".tf_workspace_member_accounts`);
    await denied(client, `SET ROLE ${escapeIdentifier(appOwner)}`);
    await assert.rejects(
      client.query('SELECT * FROM app.workspace_member_profiles($1,NULL)', [workspace.id]),
      /Invalid member profile batch/,
    );
    const events = await source.pending();
    const event = events.find(event => event.user_id === workspace.userId);
    assert.ok(event);
    await db.platform.query('UPDATE app.users SET name=$2 WHERE id=$1', [workspace.userId, 'New revision']);
    assert.equal(await source.advance(event, null), false);
    assert.equal((await source.pending()).find(event => event.user_id === workspace.userId).revision, '2');
  } finally {
    await client?.end();
    try {
      for (const role of roles.reverse()) {
        await db.databaseAdmin.query(`DROP OWNED BY ${escapeIdentifier(role)} CASCADE`);
        await db.admin.query(`DROP ROLE ${escapeIdentifier(role)}`);
      }
    } finally {
      await db.close();
    }
  }
});
