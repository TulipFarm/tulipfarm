import assert from 'node:assert/strict';
import { test } from 'node:test';
import { githubFixture } from './fixture.mjs';

const tokens = n => ({
  access_token: `access-${n}`,
  token_type: 'bearer',
  scope: 'repo',
  expires_in: 28800,
  refresh_token: `refresh-${n}`,
  refresh_token_expires_in: 15811200,
});

test('GitHub App user tokens refresh in place without changing the account generation', async t => {
  const f = await githubFixture({ scopes: ['repo'] });
  const { service, one, member, db, table } = f;
  let grants = 0;
  f.setBehavior(async (url, init) => {
    if (!url.endsWith('/access_token')) return f.defaultBehavior(url, init);
    const body = new URLSearchParams(init.body);
    if (body.get('grant_type') !== 'refresh_token') return Response.json(tokens(0));
    grants++;
    if (body.get('refresh_token') !== `refresh-${grants - 1}`) return Response.json({ error: 'bad_refresh_token' });
    await new Promise(resolve => setTimeout(resolve, 50));
    return Response.json(tokens(grants));
  });
  const expireAccess = (id, interval) =>
    db.platform.query(
      `UPDATE ${table('tf_github_accounts')} SET access_expires_at=clock_timestamp()+$2::interval WHERE id=$1`,
      [id, interval],
    );
  const row = async id =>
    (await db.platform.query(`SELECT * FROM ${table('tf_github_accounts')} WHERE id=$1`, [id])).rows[0];
  try {
    const id = await f.connect();
    const connected = await row(id);
    assert.ok(connected.refresh_credential);
    assert.ok(connected.expires_at.getTime() - connected.access_expires_at.getTime() > 86400000);
    assert.equal(
      await service.withCredential(one.id, member.userId, id, async credential => credential.accessToken),
      'access-0',
    );
    assert.equal(grants, 0);

    await t.test('an expiring access token is renewed once for concurrent callers', async () => {
      await expireAccess(id, '-1 minute');
      const seen = await Promise.all([
        service.withCredential(one.id, member.userId, id, async c => [c.accessToken, c.generation]),
        service.withCredential(one.id, member.userId, id, async c => [c.accessToken, c.generation]),
      ]);
      assert.deepEqual(seen, [
        ['access-1', connected.generation],
        ['access-1', connected.generation],
      ]);
      assert.equal(grants, 1);
      const renewed = await row(id);
      assert.equal(renewed.generation, connected.generation);
      assert.equal(renewed.state, 'active');
      assert.ok(renewed.access_expires_at.getTime() > Date.now() + 7 * 3600000);
      assert.equal(JSON.stringify(renewed).includes('refresh-1'), false);
    });
    await t.test('a read credential pinned to the generation survives renewal', async () => {
      await expireAccess(id, '5 minutes');
      assert.equal(
        await service.withReadCredential(one.id, member.userId, id, async c => c.accessToken, connected.generation),
        'access-2',
      );
      assert.equal(grants, 2);
    });
    await t.test('a refused refresh token forces reconnect and bumps the generation', async () => {
      await db.platform.query(`UPDATE ${table('tf_github_accounts')} SET access_expires_at=clock_timestamp()`);
      grants = 99;
      await assert.rejects(
        service.withCredential(one.id, member.userId, id, async () => assert.fail()),
        /account-reconnect-required/,
      );
      const rejected = await row(id);
      assert.equal(rejected.state, 'reconnect-required');
      assert.equal(rejected.refresh_credential, null);
      assert.equal(rejected.generation, connected.generation + 1);
    });
  } finally {
    await f.close();
  }
});
