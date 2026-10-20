import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { conversationFixture } from '../../conversations/test/fixture.mjs';
import { createGovernanceService } from '../../workspaces/dist/governance.js';
import { recommendationCompatibility } from '@tulipfarm/workspace-storage/recommendations';
import { createWorkspaceMember } from '../../tables/test/fixture.mjs';
import { workspaceMembersTable } from '../../tables/dist/store.js';

test(
  'governance emits actual invitation, team and role changes, not reads or repeated commands',
  { timeout: 60000 },
  async () => {
    const f = await conversationFixture();
    try {
      const { id: workspaceId, userId, membershipId } = f.workspace;
      const bob = randomUUID(),
        bobUserId = randomUUID(),
        futureUserId = randomUUID(),
        teamId = randomUUID();
      await f.db.platform.query(
        `INSERT INTO app.users(id,name,email,canonical_email,email_verified)
      VALUES($1,'Bob','bob@example.test','bob@example.test',true),
      ($2,'Future member','future-member@example.test','future-member@example.test',true)`,
        [bobUserId, futureUserId],
      );
      await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')}(id,user_id,role) VALUES($1,$2,'member')`, [
        bob,
        bobUserId,
      ]);
      const governance = createGovernanceService({
        runtime: f.runtime,
        identity: f.db.platform,
        compatibility: recommendationCompatibility,
        emailDelivery: {
          keys: { keyId: 'fixture', key: Buffer.alloc(32, 1), previous: new Map() },
          webOrigin: 'http://localhost:5173',
        },
      });
      const events = async () =>
        (
          await f.db.platform.query(
            `SELECT source_id,membership_ids FROM ${f.table('tf_recommendation_events')} ORDER BY created_at,id`,
          )
        ).rows;
      const team = { name: 'Support', description: '' };
      await governance.createTeam(workspaceId, userId, teamId, team);
      await governance.createTeam(workspaceId, userId, teamId, team);
      assert.deepEqual(await events(), [{ source_id: teamId, membership_ids: [membershipId] }]);
      await governance.renameTeam(workspaceId, userId, teamId, { ...team, name: 'Support team', expected: team });
      await governance.snapshot(workspaceId, userId);
      assert.equal((await events()).length, 1, 'cosmetic names and reads do not enqueue');
      await governance.setEnrollment(workspaceId, userId, teamId, bob, { enrolled: true });
      await governance.setEnrollment(workspaceId, userId, teamId, bob, { enrolled: true });
      assert.equal((await events()).length, 2);
      assert.deepEqual((await events()).at(-1).membership_ids, [bob]);
      await governance.setMemberRole(workspaceId, userId, bob, { role: 'admin' });
      await governance.setMemberRole(workspaceId, userId, bob, { role: 'admin' });
      assert.equal((await events()).length, 3);
      await governance.setEnrollment(workspaceId, userId, teamId, bob, { enrolled: false });
      assert.equal((await events()).length, 4);
      const beforeMember = await events();
      const futureMember = await createWorkspaceMember({
        runtime: f.runtime,
        workspace: f.workspace,
        profile: { name: 'Future member', contactEmail: 'future-member@example.test' },
      });
      const memberTable = await workspaceMembersTable({ client: f.db.platform, schema: f.workspace.names.schema });
      assert.deepEqual(
        await events(),
        [...beforeMember, { source_id: memberTable.coreDefinition.id, membership_ids: [membershipId, bob].sort() }],
        'Creating the fixture member adds exactly one table-row event',
      );
      const input = {
        kind: 'email',
        email: 'future-member@example.test',
        requestId: randomUUID(),
        workspaceMemberId: futureMember.id,
      };
      const invitation = await governance.createInvitation(workspaceId, userId, input);
      await governance.createInvitation(workspaceId, userId, input);
      await governance.createInvitation(workspaceId, userId, { ...input, requestId: randomUUID() });
      await governance.copyInvitation(workspaceId, userId, invitation.invitation.id);
      await governance.listInvitations(workspaceId, userId);
      assert.equal(
        (await events()).length,
        5 + 1,
        'invitation receipt, pending duplicate, copy and list do not enqueue',
      );
      assert.equal(
        (await f.db.platform.query(`SELECT count(*)::int AS count FROM ${f.table('tf_recommendation_expiries')}`))
          .rows[0].count,
        1,
      );
      const resend = { requestId: randomUUID() };
      const next = await governance.resendInvitation(workspaceId, userId, invitation.invitation.id, resend);
      await governance.resendInvitation(workspaceId, userId, invitation.invitation.id, resend);
      assert.equal((await events()).length, 6 + 1);
      await governance.revokeInvitation(workspaceId, userId, next.invitation.id);
      await governance.revokeInvitation(workspaceId, userId, next.invitation.id);
      assert.equal((await events()).length, 7 + 1);
      const final = await governance.createInvitation(workspaceId, userId, { ...input, requestId: randomUUID() });
      const { url } = await governance.copyInvitation(workspaceId, userId, final.invitation.id);
      const token = new URL(url).searchParams.get('token');
      const admitted = await governance.redeemInvitation(futureUserId, token);
      await governance.redeemInvitation(futureUserId, token);
      assert.equal((await events()).length, 9 + 1);
      assert.equal(
        (
          await f.db.platform.query(
            `SELECT status FROM ${f.table('tf_recommendation_refresh')} WHERE membership_id=$1`,
            [admitted.membershipId],
          )
        ).rows[0].status,
        'pending',
      );
      await governance.removeMember(workspaceId, userId, bob);
      assert.deepEqual((await events()).at(-1).membership_ids, [membershipId, bob, admitted.membershipId].sort());
    } finally {
      await f.close();
    }
  },
);
