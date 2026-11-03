import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { createSecrets } from '../dist/index.js';
import { recordUse, resolveForSend } from '../dist/send.js';
import { code, denied, keyring, setup } from './fixture.mjs';

test('secrets', async t => {
  const f = await setup();
  t.after(() => f.close());
  const [ana, ben, cy] = f.members;
  const ws = f.workspace.id;

  await t.test('stores ciphertext only and replays a repeated request', async () => {
    const input = f.input();
    const created = await f.secrets.create(ws, ana, input);
    assert.equal(created.status, 'active');
    assert.equal(created.lifetime, 'saved');
    assert.deepEqual(created.destinations, [{ kind: 'host', value: 'api.posthog.com' }]);
    assert.deepEqual(await f.secrets.create(ws, ana, input), created);
    assert.equal((await f.secrets.list(ws, ana)).filter(secret => secret.id === created.id).length, 1);
    await assert.rejects(f.secrets.create(ws, ana, { ...input, name: 'Other' }), code('conflict'));
    const dump = await f.db.platform.query(
      `SELECT row_to_json(s)::text AS secret FROM ${f.table('tf_secrets')} s UNION ALL
       SELECT row_to_json(e)::text FROM ${f.table('tf_secret_events')} e UNION ALL
       SELECT row_to_json(c)::text FROM ${f.table('tf_secret_commands')} c`,
    );
    assert.equal(
      dump.rows.some(row => row.secret.includes('phx-synthetic')),
      false,
    );
    const resolved = await f.send(ana, created.id);
    assert.deepEqual(resolved.value, { value: 'phx-synthetic-secret-value' });
    assert.deepEqual(resolved.placement, { kind: 'bearer' });
  });

  await t.test('sharing with a member, a team or the workspace allows use, never management', async () => {
    const secret = await f.secrets.create(ws, ana, f.input());
    await assert.rejects(f.send(ben, secret.id), denied);
    await assert.rejects(f.secrets.get(ws, ben, secret.id), denied);
    await assert.rejects(f.secrets.get(ws, f.admin, secret.id), denied);

    const team = randomUUID();
    await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'Growth')`, [team]);
    await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
      cy.membershipId,
      team,
    ]);
    const shared = await f.secrets.setGrants(ws, ana, secret.id, {
      requestId: randomUUID(),
      expectedPolicyVersion: 1,
      grants: [
        { grantee: { kind: 'member', membershipId: ben.membershipId }, role: 'use' },
        { grantee: { kind: 'team', teamId: team }, role: 'use' },
      ],
    });
    assert.equal(shared.policyVersion, 2);
    assert.ok(await f.send(ben, secret.id));
    assert.ok(await f.send(cy, secret.id));
    const seen = await f.secrets.get(ws, ben, secret.id);
    assert.equal(seen.canManage, false);
    assert.deepEqual(seen.grants, []);
    await assert.rejects(
      f.secrets.replace(ws, ben, secret.id, { requestId: randomUUID(), expectedVersion: 1, value: { value: 'x1234' } }),
      denied,
    );
    await assert.rejects(f.send(f.admin, secret.id), denied);
    await f.secrets.setGrants(ws, ana, secret.id, {
      requestId: randomUUID(),
      expectedPolicyVersion: 2,
      grants: [{ grantee: { kind: 'workspace' }, role: 'use' }],
    });
    assert.ok(await f.send(f.admin, secret.id));
    await assert.rejects(
      f.secrets.setGrants(ws, ana, secret.id, {
        requestId: randomUUID(),
        expectedPolicyVersion: 3,
        grants: [{ grantee: { kind: 'workspace' }, role: 'manage' }],
      }),
      code('invalid-input'),
    );
    await assert.rejects(
      f.secrets.setGrants(ws, ana, secret.id, { requestId: randomUUID(), expectedPolicyVersion: 2, grants: [] }),
      code('conflict'),
    );
  });

  await t.test('a manager can share for use but only the owner names managers', async () => {
    const secret = await f.secrets.create(ws, ana, f.input());
    await f.secrets.setGrants(ws, ana, secret.id, {
      requestId: randomUUID(),
      expectedPolicyVersion: 1,
      grants: [{ grantee: { kind: 'member', membershipId: ben.membershipId }, role: 'manage' }],
    });
    const managerGrant = { grantee: { kind: 'member', membershipId: ben.membershipId }, role: 'manage' };
    await f.secrets.setGrants(ws, ben, secret.id, {
      requestId: randomUUID(),
      expectedPolicyVersion: 2,
      grants: [managerGrant, { grantee: { kind: 'member', membershipId: cy.membershipId }, role: 'use' }],
    });
    await assert.rejects(
      f.secrets.setGrants(ws, ben, secret.id, {
        requestId: randomUUID(),
        expectedPolicyVersion: 3,
        grants: [managerGrant, { grantee: { kind: 'member', membershipId: cy.membershipId }, role: 'manage' }],
      }),
      denied,
    );
    assert.equal((await f.secrets.history(ws, ben, secret.id)).length, 3);
    await assert.rejects(f.secrets.history(ws, cy, secret.id), denied);
  });

  await t.test('replacing creates a version that stale sends and approvals fail on', async () => {
    const secret = await f.secrets.create(ws, ana, f.input());
    const before = await f.send(ana, secret.id);
    const replaced = await f.secrets.replace(ws, ana, secret.id, {
      requestId: randomUUID(),
      expectedVersion: 1,
      value: { value: 'phx-new-value' },
    });
    assert.equal(replaced.version, 2);
    assert.ok(replaced.replacedAt);
    await assert.rejects(
      f.secrets.replace(ws, ana, secret.id, { requestId: randomUUID(), expectedVersion: 1, value: { value: 'abcd1' } }),
      code('conflict'),
    );
    await assert.rejects(
      f.send(ana, secret.id, undefined, {
        expected: { version: before.version, policyVersion: before.policyVersion },
      }),
      code('conflict'),
    );
    assert.deepEqual((await f.send(ana, secret.id)).value, { value: 'phx-new-value' });
  });

  await t.test('destinations limit where a secret may go, and removing one applies at once', async () => {
    const secret = await f.secrets.create(
      ws,
      ana,
      f.input({
        placement: { kind: 'query', name: 'api_key' },
        destinations: [
          { kind: 'host', host: 'api.posthog.com' },
          { kind: 'endpoint', url: 'https://mcp.posthog.com/mcp' },
        ],
      }),
    );
    assert.ok(await f.send(ana, secret.id, 'https://api.posthog.com/v1/x?api_key=redacted-anyway'));
    assert.ok(await f.send(ana, secret.id, 'https://mcp.posthog.com/mcp'));
    await assert.rejects(f.send(ana, secret.id, 'https://mcp.posthog.com/other'), code('destination-denied'));
    await assert.rejects(f.send(ana, secret.id, 'https://eu.posthog.com/v1'), code('destination-denied'));
    await f.secrets.setDestinations(ws, ana, secret.id, {
      requestId: randomUUID(),
      expectedPolicyVersion: 1,
      destinations: [{ kind: 'endpoint', url: 'https://mcp.posthog.com/mcp' }],
    });
    await assert.rejects(f.send(ana, secret.id), code('destination-denied'));
    await assert.rejects(
      f.secrets.setDestinations(ws, ana, secret.id, {
        requestId: randomUUID(),
        expectedPolicyVersion: 2,
        destinations: [{ kind: 'host', host: '10.0.0.1' }],
      }),
      code('destination-denied'),
    );
    await f.runtime.transaction(ws, commonCompatibility, tx =>
      recordUse(f.secrets, tx, {
        secretId: secret.id,
        membershipId: ana.membershipId,
        tool: 'mcp',
        url: 'https://mcp.posthog.com/mcp?api_key=phx-synthetic-secret-value',
      }),
    );
    const used = (await f.secrets.history(ws, ana, secret.id)).at(-1);
    assert.equal(used.operation, 'used');
    assert.equal(used.details.url, 'https://mcp.posthog.com/mcp');
    assert.ok((await f.secrets.get(ws, ana, secret.id)).lastUsedAt);
  });

  await t.test('temporary secrets stay in their chat, cannot be shared and always expire', async () => {
    const chat = { kind: 'chat', conversationId: randomUUID() };
    const secret = await f.secrets.create(
      ws,
      ana,
      f.input({ lifetime: { kind: 'conversation', origin: chat }, placementSource: 'agent' }),
    );
    assert.equal(secret.lifetime, 'conversation');
    const hours = (Date.parse(secret.expiresAt) - Date.now()) / 3_600_000;
    assert.ok(hours > 23.9 && hours <= 24.01, String(hours));
    await assert.rejects(f.send(ana, secret.id), denied);
    await assert.rejects(
      f.send(ana, secret.id, undefined, { secret: { origin: { kind: 'chat', conversationId: randomUUID() } } }),
      denied,
    );
    assert.ok(await f.send(ana, secret.id, undefined, { secret: { origin: chat } }));
    await assert.rejects(
      f.secrets.create(
        ws,
        ana,
        f.input({
          lifetime: { kind: 'conversation', origin: chat },
          grants: [{ grantee: { kind: 'workspace' }, role: 'use' }],
        }),
      ),
      code('invalid-input'),
    );
    await assert.rejects(
      f.secrets.setGrants(ws, ana, secret.id, {
        requestId: randomUUID(),
        expectedPolicyVersion: 1,
        grants: [{ grantee: { kind: 'workspace' }, role: 'use' }],
      }),
      code('invalid-input'),
    );
    await assert.rejects(
      f.secrets.setExpiry(ws, ana, secret.id, { requestId: randomUUID(), expectedPolicyVersion: 1, expiresAt: null }),
      code('invalid-input'),
    );
    const saved = await f.secrets.save(ws, ana, secret.id, { requestId: randomUUID(), expectedPolicyVersion: 1 });
    assert.equal(saved.lifetime, 'saved');
    assert.equal(saved.origin, null);
    assert.equal(saved.expiresAt, null);
    assert.ok(await f.send(ana, secret.id));
  });

  await t.test('deleting an origin removes only its temporary secrets', async () => {
    const run = { kind: 'task', taskId: randomUUID(), runId: randomUUID() };
    const other = { ...run, runId: randomUUID() };
    const mine = await f.secrets.create(ws, ana, f.input({ lifetime: { kind: 'conversation', origin: run } }));
    const theirs = await f.secrets.create(ws, ana, f.input({ lifetime: { kind: 'conversation', origin: other } }));
    assert.equal(await f.runtime.transaction(ws, commonCompatibility, tx => f.secrets.deleteOrigin(tx, run)), 1);
    await assert.rejects(f.send(ana, mine.id, undefined, { secret: { origin: run } }), code('unavailable'));
    assert.ok(await f.send(ana, theirs.id, undefined, { secret: { origin: other } }));
  });

  await t.test('expired secrets fail before the sweep and are deleted by it', async () => {
    const secret = await f.secrets.create(ws, ana, f.input({ expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    await assert.rejects(
      f.secrets.create(ws, ana, f.input({ expiresAt: new Date(Date.now() - 1000).toISOString() })),
      code('invalid-input'),
    );
    await f.db.platform.query(
      `UPDATE ${f.table('tf_secrets')} SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
      [secret.id],
    );
    await assert.rejects(f.send(ana, secret.id), code('expired'));
    assert.equal((await f.secrets.get(ws, ana, secret.id)).status, 'expired');
    assert.ok((await f.secrets.sweepExpired(ws)) >= 1);
    const after = await f.secrets.get(ws, ana, secret.id);
    assert.equal(after.status, 'deleted');
    assert.equal((await f.secrets.history(ws, ana, secret.id)).at(-1).operation, 'expired');
  });

  await t.test('an owner leaving suspends the secret until a manager takes it over', async () => {
    const leaver = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
    await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      leaver.membershipId,
      leaver.userId,
    ]);
    const managed = await f.secrets.create(
      ws,
      leaver,
      f.input({
        grants: [
          { grantee: { kind: 'member', membershipId: ben.membershipId }, role: 'manage' },
          { grantee: { kind: 'member', membershipId: cy.membershipId }, role: 'use' },
        ],
      }),
    );
    const orphan = await f.secrets.create(ws, leaver, f.input());
    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at = now() WHERE id = $1`, [
      leaver.membershipId,
    ]);
    await assert.rejects(f.send(cy, managed.id), code('unavailable'));
    assert.equal((await f.secrets.get(ws, ben, managed.id)).status, 'suspended');
    await assert.rejects(
      f.secrets.delete(ws, f.admin, managed.id, { requestId: randomUUID(), expectedVersion: 1 }),
      denied,
    );
    const taken = await f.secrets.takeOwnership(ws, ben, managed.id, {
      requestId: randomUUID(),
      expectedVersion: 1,
      value: { value: 'phx-taken-over' },
    });
    assert.equal(taken.ownerMembershipId, ben.membershipId);
    assert.equal(taken.status, 'active');
    assert.deepEqual((await f.send(cy, managed.id)).value, { value: 'phx-taken-over' });

    assert.ok((await f.secrets.list(ws, f.admin)).some(secret => secret.id === orphan.id));
    await assert.rejects(f.send(f.admin, orphan.id), code('unavailable'));
    await f.secrets.delete(ws, f.admin, orphan.id, { requestId: randomUUID(), expectedVersion: 1 });
    await assert.rejects(f.send(ana, orphan.id), code('unavailable'));
  });

  await t.test('deleting makes every send fail at once', async () => {
    const secret = await f.secrets.create(ws, ana, f.input());
    await f.secrets.delete(ws, ana, secret.id, { requestId: randomUUID(), expectedVersion: 1 });
    await assert.rejects(f.send(ana, secret.id), code('unavailable'));
    const row = await f.db.platform.query(`SELECT credential, version FROM ${f.table('tf_secrets')} WHERE id = $1`, [
      secret.id,
    ]);
    assert.deepEqual(row.rows[0], { credential: null, version: 2 });
    assert.equal(
      (await f.secrets.list(ws, ana)).some(item => item.id === secret.id),
      false,
    );
  });

  await t.test('without a key or the switch, secrets are unavailable', async () => {
    const off = createSecrets({ runtime: f.runtime, keyring, enabled: false });
    assert.deepEqual(off.capabilities(), { enabled: false });
    await assert.rejects(off.create(ws, ana, f.input()), code('disabled'));
    const keyless = createSecrets({
      runtime: f.runtime,
      keyring: () => {
        throw new Error('missing');
      },
      enabled: true,
    });
    assert.deepEqual(keyless.capabilities(), { enabled: false });
    const secret = await f.secrets.create(ws, ana, f.input());
    await assert.rejects(
      f.runtime.transaction(ws, commonCompatibility, tx =>
        resolveForSend(keyless, tx, {
          workspaceId: ws,
          membershipId: ana.membershipId,
          secret: { kind: 'secret', secretId: secret.id },
          url: 'https://api.posthog.com/',
        }),
      ),
      code('credential-unavailable'),
    );
  });
});
