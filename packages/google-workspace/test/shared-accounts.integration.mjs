import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createGoogleOperations } from '../src/operations.ts';
import { createGoogleApproval } from '../src/operation-approval.ts';
import { googleFixture } from './fixture.mjs';

test('multiple personal and shared Google accounts enforce grants, explicit routing, revocation, and verified links', async () => {
  const f = await googleFixture();
  try {
    const bob = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
    const carol = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
    for (const person of [bob, carol]) {
      await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        person.membershipId,
        person.userId,
      ]);
    }
    const alicePrincipal = f.principal;
    const bobPrincipal = { userId: bob.userId, sessionId: randomUUID() };

    f.behavior({ account: 'alice-sub-1', email: 'alice@example.com' });
    const alicePersonal1 = await f.connect(alicePrincipal, undefined, { label: 'Alice Primary' });

    f.behavior({ account: 'alice-sub-2', email: 'alice-alt@example.com' });
    const alicePersonal2 = await f.connect(alicePrincipal, undefined, { newAccount: true, label: 'Alice Secondary' });

    f.behavior({ account: 'team-sub-1', email: 'team@example.com' });
    const shared = await f.connect(alicePrincipal, undefined, { ownership: 'shared', label: 'Team Inbox' });

    assert.notEqual(alicePersonal1.integrationId, alicePersonal2.integrationId);
    assert.notEqual(alicePersonal1.integrationId, shared.integrationId);

    const aliceAccounts = await f.service.list(f.workspace.id, f.member.userId);
    assert.equal(aliceAccounts.length, 3);
    assert.deepEqual(
      aliceAccounts.map(a => [a.email, a.ownership, a.label, a.canUse, a.canManage]),
      [
        ['alice-alt@example.com', 'personal', 'Alice Secondary', true, true],
        ['alice@example.com', 'personal', 'Alice Primary', true, true],
        ['team@example.com', 'shared', 'Team Inbox', true, true],
      ],
    );

    // Bob connects his own personal account; before any grant he only sees his personal account.
    f.behavior({ account: 'bob-sub-1', email: 'bob@example.com' });
    await f.connect(bobPrincipal);
    assert.deepEqual(
      (await f.service.list(f.workspace.id, bob.userId)).map(a => a.email),
      ['bob@example.com'],
    );

    const initialGrants = await f.service.listGrants(f.workspace.id, f.member.userId, shared.integrationId);
    assert.equal(initialGrants.grantsVersion, 1);
    assert.deepEqual(initialGrants.grants, [{ kind: 'member', membershipId: f.member.membershipId, role: 'manage' }]);

    await assert.rejects(
      f.service.setGrants(f.workspace.id, f.member.userId, shared.integrationId, {
        expectedGrantsVersion: 99,
        grants: [{ kind: 'member', membershipId: f.member.membershipId, role: 'manage' }],
      }),
      { message: 'grants-conflict' },
    );

    await assert.rejects(
      f.service.setGrants(f.workspace.id, f.member.userId, shared.integrationId, {
        expectedGrantsVersion: 1,
        grants: [{ kind: 'member', membershipId: bob.membershipId, role: 'use' }],
      }),
      { message: 'invalid-grant' },
    );

    const updatedGrants = await f.service.setGrants(f.workspace.id, f.member.userId, shared.integrationId, {
      expectedGrantsVersion: 1,
      grants: [
        { kind: 'member', membershipId: f.member.membershipId, role: 'manage' },
        { kind: 'member', membershipId: bob.membershipId, role: 'use' },
      ],
    });
    assert.equal(updatedGrants.grantsVersion, 2);

    const bobAccounts = await f.service.list(f.workspace.id, bob.userId);
    assert.deepEqual(
      bobAccounts.map(a => [a.email, a.ownership, a.canUse, a.canManage]),
      [
        ['bob@example.com', 'personal', true, true],
        ['team@example.com', 'shared', true, false],
      ],
    );

    // Bob holds only 'use', so managing grants or disconnecting the shared account is denied.
    await assert.rejects(f.service.listGrants(f.workspace.id, bob.userId, shared.integrationId), AccessDenied);
    await assert.rejects(f.service.disconnect(f.workspace.id, bob.userId, shared.integrationId), AccessDenied);

    const providerRequests = [];
    const operations = createGoogleOperations({
      runtime: f.runtime,
      integrations: f.service,
      fetcher: async (url, init) => {
        providerRequests.push({ url: String(url), method: init?.method ?? 'GET' });
        if (String(url).includes('/gmail/v1/users/me/messages/send')) {
          return Response.json({ id: 'sent-msg-1', threadId: 'thread-1' });
        }
        return Response.json({ messages: [{ id: 'msg-1', threadId: 'thread-1' }] });
      },
    });
    const approve = createGoogleApproval({
      runtime: f.runtime,
      resolveConfirmationCredential: async () => f.db.login(f.workspace, 'confirmation'),
    });

    const readOp = { kind: 'gmail.messages.list', maxResults: 5 };
    const bobSharedRead = await operations.read(f.workspace.id, bob.userId, {
      operation: readOp,
      integrationId: shared.integrationId,
    });
    assert.equal(bobSharedRead.untrusted, true);

    const sendOp = {
      kind: 'gmail.messages.send',
      message: {
        to: ['recipient@example.com'],
        subject: 'Shared update',
        body: 'Sent via shared account.',
      },
    };
    const proposal = await operations.propose(f.workspace.id, bob.userId, {
      commandId: randomUUID(),
      operation: sendOp,
      integrationId: shared.integrationId,
    });
    assert.equal(proposal.integration.integrationId, shared.integrationId);

    const approved = await approve(f.workspace.id, bob.userId, proposal.id, {
      digest: proposal.digest,
      decision: 'approve',
    });
    assert.equal(approved.decision, 'approve');

    const executed = await operations.execute(f.workspace.id, bob.userId, proposal.id);
    assert.equal(executed?.status, 'succeeded');

    // Carol has no grant on the shared account and is denied immediately.
    await assert.rejects(
      operations.read(f.workspace.id, carol.userId, {
        operation: readOp,
        integrationId: shared.integrationId,
      }),
      AccessDenied,
    );

    // Revoking Bob's grant immediately blocks subsequent reads and proposals on the shared account.
    await f.service.setGrants(f.workspace.id, f.member.userId, shared.integrationId, {
      expectedGrantsVersion: 2,
      grants: [{ kind: 'member', membershipId: f.member.membershipId, role: 'manage' }],
    });
    assert.deepEqual(
      (await f.service.list(f.workspace.id, bob.userId)).map(a => a.email),
      ['bob@example.com'],
    );
    await assert.rejects(
      operations.read(f.workspace.id, bob.userId, {
        operation: readOp,
        integrationId: shared.integrationId,
      }),
      AccessDenied,
    );
    // Bob's own personal account still works without an explicit integrationId.
    const bobPersonalRead = await operations.read(f.workspace.id, bob.userId, { operation: readOp });
    assert.equal(bobPersonalRead.untrusted, true);

    const membersTableId = (
      await f.db.platform.query(`SELECT table_id FROM ${f.table('tf_system_tables')} WHERE kind = 'workspace-members'`)
    ).rows[0].table_id;
    const aliceMemberRowId = (
      await f.db.platform.query(
        `SELECT member_id FROM ${f.table('tf_workspace_member_accounts')} WHERE membership_id = $1`,
        [f.member.membershipId],
      )
    ).rows[0].member_id;
    await f.db.platform.query(
      `UPDATE ${f.table('tf_table_identities')} SET live = true WHERE table_id = $1 AND row_id = $2`,
      [membersTableId, aliceMemberRowId],
    );
    const verified = (
      await f.db.platform.query(
        `SELECT external_id, handle FROM ${f.table('tf_member_verified_links')}
         WHERE provider = 'google' AND membership_id = $1
         ORDER BY handle ASC`,
        [f.member.membershipId],
      )
    ).rows;
    assert.deepEqual(verified, [
      { external_id: 'alice-sub-2', handle: 'alice-alt@example.com' },
      { external_id: 'alice-sub-1', handle: 'alice@example.com' },
    ]);
    assert.equal(
      verified.some(row => row.handle === 'team@example.com'),
      false,
    );
  } finally {
    await f.close();
  }
});

test('a personal account can be shared in place and reverted back to personal without reconnecting', async () => {
  const f = await googleFixture();
  try {
    const bob = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
    await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      bob.membershipId,
      bob.userId,
    ]);
    const operations = createGoogleOperations({
      runtime: f.runtime,
      integrations: f.service,
      fetcher: async () => Response.json({ messages: [{ id: 'm-inplace', threadId: 't-inplace' }] }),
    });

    f.behavior({ account: 'alice-inplace-sub', email: 'hello-team@example.com' });
    const personal = await f.connect(f.principal, undefined, { ownership: 'personal', label: 'Hello Team' });

    const initialGrants = await f.service.listGrants(f.workspace.id, f.member.userId, personal.integrationId);
    assert.deepEqual(initialGrants.grants, []);
    assert.equal(initialGrants.grantsVersion, 1);

    await assert.rejects(f.service.listGrants(f.workspace.id, bob.userId, personal.integrationId), AccessDenied);

    const promoted = await f.service.setGrants(f.workspace.id, f.member.userId, personal.integrationId, {
      expectedGrantsVersion: 1,
      grants: [
        { kind: 'member', membershipId: f.member.membershipId, role: 'manage' },
        { kind: 'member', membershipId: bob.membershipId, role: 'use' },
      ],
    });
    assert.equal(promoted.grantsVersion, 2);

    const aliceListShared = await f.service.list(f.workspace.id, f.member.userId);
    assert.equal(aliceListShared[0].ownership, 'shared');
    assert.equal(aliceListShared[0].canManage, true);
    assert.deepEqual(aliceListShared[0].shareSummary, { workspace: false, memberCount: 2, teamCount: 0 });

    const bobListShared = await f.service.list(f.workspace.id, bob.userId);
    assert.equal(bobListShared.length, 1);
    assert.equal(bobListShared[0].email, 'hello-team@example.com');
    assert.equal(bobListShared[0].ownership, 'shared');
    assert.equal(bobListShared[0].canManage, false);

    const readOp = { kind: 'gmail.messages.list', q: 'in:inbox', maxResults: 1 };
    const bobRead = await operations.read(f.workspace.id, bob.userId, {
      operation: readOp,
      integrationId: personal.integrationId,
    });
    assert.equal(bobRead.untrusted, true);

    await assert.rejects(
      f.service.setGrants(f.workspace.id, bob.userId, personal.integrationId, {
        expectedGrantsVersion: 2,
        grants: [],
      }),
      AccessDenied,
    );

    const reverted = await f.service.setGrants(f.workspace.id, f.member.userId, personal.integrationId, {
      expectedGrantsVersion: 2,
      grants: [],
    });
    assert.equal(reverted.grantsVersion, 3);
    assert.deepEqual(reverted.grants, []);

    const aliceListPersonal = await f.service.list(f.workspace.id, f.member.userId);
    assert.equal(aliceListPersonal[0].ownership, 'personal');
    assert.equal(aliceListPersonal[0].canManage, true);

    assert.deepEqual(await f.service.list(f.workspace.id, bob.userId), []);
    await assert.rejects(
      operations.read(f.workspace.id, bob.userId, {
        operation: readOp,
        integrationId: personal.integrationId,
      }),
      AccessDenied,
    );

    const aliceRead = await operations.read(f.workspace.id, f.member.userId, {
      operation: readOp,
      integrationId: personal.integrationId,
    });
    assert.equal(aliceRead.untrusted, true);
  } finally {
    await f.close();
  }
});
