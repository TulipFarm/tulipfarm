import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTokenPlan, TokenPlanError } from '@tulipfarm/integrations/token-plans';
import { githubFixture } from './fixture.mjs';

const models = [{ slug: 'gpt-5-mini', label: 'GPT-5 mini' }];

test('Copilot uses a personal GitHub account without copying its token', async () => {
  const f = await githubFixture();
  try {
    const verified = [];
    let available = models;
    const copilot = createTokenPlan({
      provider: 'copilot',
      runtime: f.runtime,
      keyring: f.keyring,
      verify: async token => {
        verified.push(token);
        return { models: available, account: 'unused@example.com' };
      },
      githubAccountToken: f.service.memberAccessToken,
    });
    const workspace = f.one.id;
    const user = f.member.userId;
    const connections = () =>
      f.db.platform
        .query(`SELECT state, credential, github_account_id FROM ${f.table('tf_subscription_connections')}`)
        .then(result => result.rows);

    const accountId = await f.connect(7);
    available = [];
    await assert.rejects(
      copilot.useGitHubAccount(workspace, user, accountId),
      error => error instanceof TokenPlanError && error.code === 'not-eligible',
    );
    assert.deepEqual(await connections(), []);

    available = models;
    assert.equal(await copilot.useGitHubAccount(workspace, user, accountId), true);
    assert.deepEqual(verified, ['synthetic-access-token', 'synthetic-access-token']);
    assert.deepEqual(await copilot.status(workspace, user), {
      state: 'connected',
      account: 'person-7',
      githubAccountId: accountId,
      planUsage: true,
      models,
    });
    assert.deepEqual(await connections(), [{ state: 'connected', credential: null, github_account_id: accountId }]);
    assert.equal(await copilot.accessToken(workspace, f.member.membershipId), 'synthetic-access-token');

    const other = await f.connect(8);
    assert.equal(await copilot.useGitHubAccount(workspace, user, other, true), false);
    assert.equal((await connections())[0].github_account_id, accountId);
    assert.equal(await copilot.useGitHubAccount(workspace, user, accountId, true), true);

    await f.service.disconnect(workspace, user, accountId);
    assert.deepEqual(await connections(), [{ state: 'signed-out', credential: null, github_account_id: null }]);
    assert.equal((await copilot.status(workspace, user)).state, 'signed-out');
    await assert.rejects(
      copilot.accessToken(workspace, f.member.membershipId),
      error => error instanceof TokenPlanError && error.code === 'not-connected',
    );

    assert.equal(await copilot.useGitHubAccount(workspace, user, other, true), true);
    assert.equal((await copilot.status(workspace, user)).account, 'person-8');
  } finally {
    await f.close();
  }
});
