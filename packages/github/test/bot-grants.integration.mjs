import assert from 'node:assert/strict';
import test from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { githubFixture } from './fixture.mjs';
import { createGitHubBotGrants } from '@tulipfarm/github/bot';

test('workspace admins grant bot posting per member and repository; members see only their own', async () => {
  const f = await githubFixture();
  try {
    const grants = createGitHubBotGrants(f.runtime, { GITHUB_APP_PRIVATE_KEY: 'configured' });
    const memberId = async membershipId =>
      (
        await f.db.platform.query(
          `SELECT member_id FROM ${f.table('tf_workspace_member_accounts')} WHERE membership_id=$1`,
          [membershipId],
        )
      ).rows[0].member_id;
    const member = await memberId(f.member.membershipId);
    const admin = await memberId(f.one.membershipId);

    assert.deepEqual(await grants.list(f.one.id, f.member.userId), { configured: true, manage: false, grants: [] });
    await assert.rejects(
      grants.add(f.one.id, f.member.userId, { memberId: member, repository: 'octocat/private' }),
      AccessDenied,
    );
    await assert.rejects(grants.add(f.one.id, f.one.userId, { memberId: member, repository: 'not a repo' }));

    await grants.add(f.one.id, f.one.userId, { memberId: member, repository: 'OctoCat/Private' });
    await grants.add(f.one.id, f.one.userId, { memberId: member, repository: 'octocat/private' });
    const all = await grants.add(f.one.id, f.one.userId, { memberId: admin, repository: 'octocat/docs' });
    assert.deepEqual(all, {
      configured: true,
      manage: true,
      grants: [
        { memberId: admin, repository: 'octocat/docs' },
        { memberId: member, repository: 'octocat/private' },
      ],
    });
    assert.deepEqual((await grants.list(f.one.id, f.member.userId)).grants, [
      { memberId: member, repository: 'octocat/private' },
    ]);

    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [
      f.member.membershipId,
    ]);
    assert.deepEqual((await grants.list(f.one.id, f.one.userId)).grants, [
      { memberId: admin, repository: 'octocat/docs' },
    ]);
    const removed = await grants.remove(f.one.id, f.one.userId, { memberId: admin, repository: 'octocat/docs' });
    assert.deepEqual(removed.grants, []);
    assert.equal((await createGitHubBotGrants(f.runtime, {}).list(f.one.id, f.one.userId)).configured, false);
  } finally {
    await f.close();
  }
});
