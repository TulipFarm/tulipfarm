import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { defineExtension, registerExtension, resetExtensions } from '@tulipfarm/extensions';
import {
  fixture,
  connect,
  loadPlatformBaseline,
  seedPlatformUser,
} from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { createGovernanceService } from '@tulipfarm/workspaces/governance';
import { createTableService } from '@tulipfarm/tables/service';
import { activeGeneration, workspaceMembersTable } from '@tulipfarm/tables/store';
import {
  manualWorkspaceMemberValues,
  workspaceMemberAccess,
  workspaceMemberFields,
} from '@tulipfarm/tables/workspace-members';

test(
  'explicit invitation binding preserves the business member through acceptance, removal, and rejoin',
  { timeout: 45000 },
  async t => {
    const db = await fixture();
    const cleanup = [];
    t.after(async () => {
      for (const close of cleanup.reverse()) await close();
      await db.close();
    });
    await loadPlatformBaseline(db.platform);
    const workspace = await db.create();
    const raw = await connect(db.login(workspace));
    cleanup.push(() => raw.end());
    const s = `"${workspace.names.schema}"`;
    const runtime = createWorkspaceRuntime({
      resolveCredential: async () => ({
        workspaceId: workspace.id,
        generation: 1,
        connectionString: db.login(workspace),
      }),
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
    });
    cleanup.push(() => runtime.close());
    const governance = createGovernanceService({
      runtime,
      identity: db.platform,
      compatibility: commonCompatibility,
      emailDelivery: {
        keys: { keyId: 'test', key: Buffer.alloc(32, 1), previous: new Map() },
        webOrigin: 'http://localhost:5173',
      },
    });
    const directory = await activeGeneration(
      { client: raw, schema: workspace.names.schema },
      (await workspaceMembersTable({ client: raw, schema: workspace.names.schema })).coreDefinition.id,
    );
    const tables = createTableService(runtime, { readableFiles: async () => new Set() }, commonCompatibility);
    const memberId = randomUUID();
    const createMember = id =>
      tables.mutate(workspace.id, workspace.userId, {
        kind: 'create',
        tableId: directory.table_id,
        revision: directory.revision,
        recordId: id,
        values: manualWorkspaceMemberValues({ name: 'Manual name', contactEmail: 'work@example.test' }),
      });
    await createMember(memberId);
    const read = () =>
      tables.read(workspace.id, workspace.userId, {
        tableId: directory.table_id,
        revision: directory.revision,
        recordId: memberId,
      });
    const accountId = randomUUID(),
      email = `${accountId}@example.test`;
    await seedPlatformUser(db.platform, { id: accountId, name: 'Account name', email });
    const input = { kind: 'email', email, requestId: randomUUID(), workspaceMemberId: memberId };
    const invited = [];
    await registerExtension(
      defineExtension({
        name: 'recorder',
        register(slots) {
          slots.hooks({
            'member.invited': payload => {
              invited.push(payload);
            },
          });
        },
      }),
      { app: 'api', env: {} },
    );
    cleanup.push(() => resetExtensions());
    await assert.rejects(
      governance.createInvitation(workspace.id, workspace.userId, { ...input, workspaceMemberId: undefined }),
      /member-selection-required/,
    );
    const invitation = await governance.createInvitation(workspace.id, workspace.userId, input);
    assert.equal(invitation.invitation.workspaceMemberId, memberId);
    assert.equal((await read()).values[workspaceMemberFields.access].optionId, workspaceMemberAccess.invited);
    assert.deepEqual(await governance.createInvitation(workspace.id, workspace.userId, input), invitation);
    assert.deepEqual(invited, [
      {
        workspaceId: workspace.id,
        invitationId: invitation.invitation.id,
        invitedByUserId: workspace.userId,
        replacesInvitationId: null,
      },
    ]);
    const otherMemberId = randomUUID();
    await createMember(otherMemberId);
    await assert.rejects(
      governance.createInvitation(workspace.id, workspace.userId, { ...input, workspaceMemberId: otherMemberId }),
      /invitation-request-conflict/,
    );
    await assert.rejects(
      governance.createInvitation(workspace.id, workspace.userId, {
        ...input,
        requestId: randomUUID(),
        workspaceMemberId: otherMemberId,
      }),
      /member-link-conflict/,
    );
    const token = async id =>
      new URL((await governance.copyInvitation(workspace.id, workspace.userId, id)).url).searchParams.get('token');
    const firstToken = await token(invitation.invitation.id);
    await assert.rejects(governance.redeemInvitation(workspace.userId, firstToken), AccessDenied);
    const admission = await governance.redeemInvitation(accountId, firstToken);
    assert.notEqual(admission.membershipId, memberId);
    assert.deepEqual(await governance.redeemInvitation(accountId, firstToken), admission);
    let person = await read();
    assert.equal(person.id, memberId);
    assert.equal(person.values[workspaceMemberFields.name].value, 'Account name');
    assert.equal(person.values[workspaceMemberFields.contactEmail].value, 'work@example.test');
    assert.equal(person.values[workspaceMemberFields.accountEmail].value, email);
    assert.equal(person.values[workspaceMemberFields.access].optionId, workspaceMemberAccess.active);
    assert.equal(
      (await raw.query(`SELECT member_id FROM ${s}.tf_workspace_member_accounts WHERE user_id=$1`, [accountId])).rows[0]
        .member_id,
      memberId,
    );
    await governance.removeMember(workspace.id, workspace.userId, admission.membershipId);
    person = await read();
    assert.equal(person.values[workspaceMemberFields.active].value, true);
    assert.equal(person.values[workspaceMemberFields.accountEmail], null);
    assert.equal(person.values[workspaceMemberFields.access].optionId, workspaceMemberAccess.none);
    await assert.rejects(governance.redeemInvitation(accountId, firstToken), AccessDenied);
    const rejoin = await governance.createInvitation(workspace.id, workspace.userId, {
      ...input,
      requestId: randomUUID(),
    });
    const secondAdmission = await governance.redeemInvitation(accountId, await token(rejoin.invitation.id));
    assert.deepEqual(
      invited.map(event => event.invitationId),
      [invitation.invitation.id, rejoin.invitation.id],
    );
    assert.notEqual(secondAdmission.membershipId, admission.membershipId);
    assert.equal(
      (await raw.query(`SELECT member_id FROM ${s}.tf_workspace_member_accounts WHERE user_id=$1`, [accountId])).rows[0]
        .member_id,
      memberId,
    );
    assert.equal((await read()).id, memberId);
    const reservedUser = randomUUID(),
      reservedAccess = randomUUID();
    await raw.query(`INSERT INTO ${s}.tf_memberships(id,user_id,role) VALUES($1,$2,'member')`, [
      reservedAccess,
      reservedUser,
    ]);
    const pendingIdentity = (
      await raw.query(`SELECT member_id FROM ${s}.tf_workspace_member_accounts WHERE user_id=$1`, [reservedUser])
    ).rows[0].member_id;
    await governance.removeMember(workspace.id, workspace.userId, reservedAccess);
    assert.deepEqual(
      (
        await raw.query(`SELECT member_id,profile_status FROM ${s}.tf_workspace_member_accounts WHERE user_id=$1`, [
          reservedUser,
        ])
      ).rows[0],
      { member_id: pendingIdentity, profile_status: 'detached' },
    );
    const pending = await governance.createInvitation(workspace.id, workspace.userId, {
      kind: 'email',
      email: `${randomUUID()}@example.test`,
      requestId: randomUUID(),
      workspaceMemberId: otherMemberId,
    });
    const resent = await governance.resendInvitation(workspace.id, workspace.userId, pending.invitation.id, {
      requestId: randomUUID(),
    });
    assert.deepEqual(invited.slice(-2), [
      {
        workspaceId: workspace.id,
        invitationId: pending.invitation.id,
        invitedByUserId: workspace.userId,
        replacesInvitationId: null,
      },
      {
        workspaceId: workspace.id,
        invitationId: resent.invitation.id,
        invitedByUserId: workspace.userId,
        replacesInvitationId: pending.invitation.id,
      },
    ]);
  },
);
