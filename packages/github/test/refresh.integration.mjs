import assert from 'node:assert/strict';
import { test } from 'node:test';
import { remoteSourceCheckLimits, withRemoteSourceCheckBudget } from '@tulipfarm/access';
import { GitHubCredentialRejected } from '@tulipfarm/github';
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
  let delay = 0;
  f.setBehavior(async (url, init) => {
    if (!url.endsWith('/access_token')) return f.defaultBehavior(url, init);
    const body = new URLSearchParams(init.body);
    if (body.get('grant_type') !== 'refresh_token') return Response.json(tokens(0));
    grants++;
    if (body.get('refresh_token') !== `refresh-${grants - 1}`) return Response.json({ error: 'bad_refresh_token' });
    await new Promise((resolve, reject) => {
      setTimeout(resolve, 50 + delay);
      init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
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
    await t.test(
      'a read whose token was refreshed concurrently retries instead of rejecting the new token',
      async () => {
        const used = [];
        assert.equal(
          await service.withReadCredential(
            one.id,
            member.userId,
            id,
            async c => {
              used.push(c.accessToken);
              if (used.length > 1) return c.accessToken;
              await expireAccess(id, '-1 minute');
              await service.withCredential(one.id, member.userId, id, async () => {});
              throw new GitHubCredentialRejected();
            },
            connected.generation,
          ),
          'access-3',
        );
        assert.deepEqual(used, ['access-2', 'access-3']);
        assert.equal(grants, 3);
        const kept = await row(id);
        assert.equal(kept.state, 'active');
        assert.equal(kept.generation, connected.generation);
      },
    );
    await t.test('a read whose token keeps changing is unavailable, never rejected', async () => {
      await assert.rejects(
        service.withReadCredential(
          one.id,
          member.userId,
          id,
          async () => {
            await expireAccess(id, '-1 minute');
            await service.withCredential(one.id, member.userId, id, async () => {});
            throw new GitHubCredentialRejected();
          },
          connected.generation,
        ),
        /account-unavailable/,
      );
      assert.equal(grants, 5);
      const kept = await row(id);
      assert.equal(kept.state, 'active');
      assert.equal(kept.generation, connected.generation);
    });
    await t.test('a refresh starts only within the shared budget and, once started, keeps its token', async () => {
      const limit = remoteSourceCheckLimits.milliseconds;
      const before = await row(id);
      const read = () => service.withReadCredential(one.id, member.userId, id, async c => c.accessToken);
      await expireAccess(id, '-1 minute');
      try {
        remoteSourceCheckLimits.milliseconds = 0;
        await assert.rejects(withRemoteSourceCheckBudget(read), /account-unavailable/);
        assert.equal(grants, 5, 'a spent budget starts no refresh');
        assert.deepEqual((await row(id)).refresh_credential, before.refresh_credential);
        remoteSourceCheckLimits.milliseconds = 100;
        delay = 400;
        assert.equal(await withRemoteSourceCheckBudget(read), 'access-6');
        assert.equal(grants, 6, 'a refresh admitted near the deadline runs to completion');
      } finally {
        delay = 0;
        remoteSourceCheckLimits.milliseconds = limit;
      }
      const kept = await row(id);
      assert.deepEqual([kept.state, kept.generation], [before.state, before.generation]);
      assert.notDeepEqual(kept.refresh_credential, before.refresh_credential);
      await expireAccess(id, '-1 minute');
      assert.equal(await read(), 'access-7', 'the replacement refresh token is the one stored');
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
