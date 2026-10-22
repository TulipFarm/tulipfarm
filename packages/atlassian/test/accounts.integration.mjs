import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { atlassianAccountCompatibility } from '../dist/accounts.js';
import { accountCredentialCipher } from '../dist/account-credentials.js';
import { AccessDenied } from '@tulipfarm/access';
import { accountFixture } from './account-fixture.mjs';

test('accounts preserve private ownership, one-time consent, isolation and rotating refresh in real PostgreSQL', async t => {
  const f = await accountFixture();
  const { service, one, two, member, db, table } = f;
  try {
    await t.test('workspaces deny cross-workspace SQL, platform reads and credential ownership rewrites', async () => {
      for (const sql of [
        `SELECT * FROM ${table('tf_atlassian_accounts', two)}`,
        'SELECT * FROM app.accounts',
        `UPDATE ${table('tf_atlassian_accounts')} SET ownership='business'`,
        `DELETE FROM ${table('tf_atlassian_accounts')}`,
        `ALTER TABLE ${table('tf_atlassian_accounts')} ADD COLUMN injected text`,
      ]) {
        await assert.rejects(
          f.runtime.transaction(one.id, atlassianAccountCompatibility, tx => tx.client.query(sql)),
          error => error.code === '42501',
        );
      }
    });
    await t.test('state is hashed, PKCE is encrypted and another user or session cannot consume consent', async () => {
      const started = await f.begin();
      const stored = (
        await db.platform.query(`SELECT * FROM ${table('tf_atlassian_account_attempts')} WHERE account_id=$1`, [
          started.accountId,
        ])
      ).rows[0];
      assert.equal(JSON.stringify(stored).includes(started.state), false);
      assert.equal(JSON.stringify(stored).includes('test-session'), false);
      const verifier = accountCredentialCipher(f.keyring).decrypt(
        { workspaceId: one.id, accountId: started.accountId, protocol: 'trello', generation: 1, purpose: 'pkce' },
        stored.verifier,
      );
      assert.match(verifier, /^[A-Za-z0-9._~-]{43,128}$/);
      const authorization = new URL(started.url);
      assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(
        authorization.searchParams.get('code_challenge'),
        createHash('sha256').update(verifier).digest('base64url'),
      );
      assert.equal(JSON.stringify(stored).includes(verifier), false);
      await assert.rejects(service.complete('code', started.state, 'wrong-session', member.userId), AccessDenied);
      await assert.rejects(service.complete('code', started.state, 'test-session', one.userId), AccessDenied);
      assert.equal(f.calls.length, 0);
      const completions = await Promise.allSettled([
        service.complete('code', started.state, 'test-session', member.userId),
        service.complete('code', started.state, 'test-session', member.userId),
      ]);
      assert.equal(completions.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(f.calls.filter(([url]) => url.endsWith('/token')).length, 1);
      assert.equal(JSON.parse(f.calls.find(([url]) => url.endsWith('/token'))[1].body).code_verifier, verifier);
      await assert.rejects(service.complete('code', started.state, 'test-session', member.userId));
      const result = await service.status(one.id, member.userId, started.accountId);
      assert.equal(result.state, 'active');
      assert.equal(result.identity.qualification, 'verified');
      assert.equal(JSON.stringify(result).includes('synthetic-'), false);
      const raw = JSON.stringify((await db.platform.query(`SELECT * FROM ${table('tf_atlassian_accounts')}`)).rows);
      assert.equal(raw.includes('synthetic-access-token'), false);
      assert.equal(raw.includes('synthetic-refresh-token'), false);
      assert.equal((await service.list(one.id, one.userId)).accounts.length, 0);
      for (const operation of [
        () => service.status(one.id, one.userId, started.accountId),
        () => service.disconnect(one.id, one.userId, started.accountId),
        () => service.reconnect(one.id, one.userId, 'admin-session', started.accountId),
        () => service.withAccessToken(one.id, one.userId, started.accountId, async () => assert.fail()),
      ])
        await assert.rejects(operation(), AccessDenied);
      await assert.rejects(service.status(two.id, two.userId, started.accountId), AccessDenied);
    });
    await t.test(
      'business creators manage explicit grants, admins get no implicit access, member and team grants are live',
      async () => {
        const id = await f.connect('trello', 'business');
        assert.deepEqual((await service.status(one.id, member.userId, id)).capabilities, {
          read: true,
          manage: true,
          use: true,
        });
        assert.deepEqual(await service.grants(one.id, member.userId, id), {
          expectedVersion: 1,
          memberIds: [member.membershipId],
          teamIds: [],
          managers: { memberIds: [member.membershipId], teamIds: [] },
        });
        await assert.rejects(service.status(one.id, one.userId, id), AccessDenied);
        await assert.rejects(
          service.withAccessToken(one.id, one.userId, id, async () => assert.fail()),
          AccessDenied,
        );
        await assert.rejects(
          service.setGrants(one.id, one.userId, id, { expectedVersion: 1, memberIds: [one.membershipId], teamIds: [] }),
          AccessDenied,
        );
        await service.setGrants(one.id, member.userId, id, { expectedVersion: 1, memberIds: [], teamIds: [f.teamId] });
        assert.equal(
          await service.withAccessToken(
            one.id,
            member.userId,
            id,
            async ({ accessToken }) => accessToken === 'synthetic-access-token',
          ),
          true,
        );
        await service.setGrants(one.id, member.userId, id, {
          expectedVersion: 2,
          memberIds: [one.membershipId],
          teamIds: [],
        });
        await assert.rejects(
          service.withAccessToken(one.id, member.userId, id, async () => assert.fail()),
          AccessDenied,
        );
        assert.equal(await service.withAccessToken(one.id, one.userId, id, async () => 'allowed'), 'allowed');
        assert.deepEqual((await service.status(one.id, one.userId, id)).capabilities, {
          read: true,
          manage: false,
          use: true,
        });
        await assert.rejects(service.disconnect(one.id, one.userId, id), AccessDenied);
        await assert.rejects(
          service.setGrants(one.id, member.userId, id, { expectedVersion: 1, memberIds: [], teamIds: [] }),
          /account-conflict/,
        );
        assert.deepEqual(await service.grants(one.id, member.userId, id), {
          expectedVersion: 3,
          memberIds: [one.membershipId],
          teamIds: [],
          managers: { memberIds: [member.membershipId], teamIds: [] },
        });
      },
    );
    await t.test(
      'REST resolves identity and sites; MCP labels its verified OAuth grant without inventing tool schemas',
      async () => {
        const rest = await f.connect('atlassian-rest');
        assert.equal((await service.status(one.id, member.userId, rest)).resources[0].id, 'cloud-id');
        const mcp = await f.connect('atlassian-mcp');
        assert.equal(
          (await service.status(one.id, member.userId, mcp)).identity.qualification,
          'grant-bound-needs-qualification',
        );
      },
    );
    await t.test('expiry, reconnect and disconnect fence old callbacks', async () => {
      const started = await f.begin();
      await db.platform.query(
        `UPDATE ${table('tf_atlassian_account_attempts')} SET expires_at=clock_timestamp()-interval '1 minute' WHERE account_id=$1`,
        [started.accountId],
      );
      await assert.rejects(service.complete('code', started.state, 'test-session', member.userId), AccessDenied);
      const next = await service.reconnect(one.id, member.userId, 'test-session', started.accountId);
      await assert.rejects(service.complete('code', started.state, 'test-session', member.userId), AccessDenied);
      await service.disconnect(one.id, member.userId, started.accountId);
      await assert.rejects(
        service.complete('code', new URL(next.url).searchParams.get('state'), 'test-session', member.userId),
        AccessDenied,
      );
      assert.equal((await service.status(one.id, member.userId, started.accountId)).state, 'disconnected');
    });
    await t.test('refresh commits a claim before the provider, serializes callers and rotates once', async () => {
      const id = await f.connect();
      await db.platform.query(`UPDATE ${table('tf_atlassian_accounts')} SET expires_at=clock_timestamp() WHERE id=$1`, [
        id,
      ]);
      let release;
      let entered;
      const ready = new Promise(resolve => {
        entered = resolve;
      });
      const pending = new Promise(resolve => {
        release = resolve;
      });
      let refreshes = 0;
      f.setBehavior(async (_url, init) => {
        refreshes++;
        assert.equal(JSON.parse(init.body).grant_type, 'refresh_token');
        assert.equal(
          (await db.platform.query(`SELECT state FROM ${table('tf_atlassian_accounts')} WHERE id=$1`, [id])).rows[0]
            .state,
          'refreshing',
        );
        entered();
        await pending;
        return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
      });
      const first = service.withAccessToken(
        one.id,
        member.userId,
        id,
        async value => value.accessToken === 'new-access',
      );
      await ready;
      await assert.rejects(
        service.withAccessToken(one.id, member.userId, id, async () => assert.fail()),
        /account-refresh-in-progress/,
      );
      release();
      assert.equal(await first, true);
      assert.equal(refreshes, 1);
      assert.equal((await service.status(one.id, member.userId, id)).generation, 2);
      assert.equal(
        await service.withAccessToken(one.id, member.userId, id, async value => value.accessToken === 'new-access'),
        true,
      );
      assert.equal(refreshes, 1);
      await db.platform.query(`UPDATE ${table('tf_atlassian_accounts')} SET expires_at=clock_timestamp() WHERE id=$1`, [
        id,
      ]);
      f.setBehavior(async () => {
        refreshes++;
        throw new Error('unknown provider outcome new-refresh');
      });
      await assert.rejects(
        service.withAccessToken(one.id, member.userId, id, async () => assert.fail()),
        /account-reconnect-required/,
      );
      await assert.rejects(
        service.withAccessToken(one.id, member.userId, id, async () => assert.fail()),
        /account-reconnect-required/,
      );
      assert.equal(refreshes, 2);
      assert.equal(
        (await db.platform.query(`SELECT credential FROM ${table('tf_atlassian_accounts')} WHERE id=$1`, [id])).rows[0]
          .credential,
        null,
      );
    });
    await t.test(
      'removed and re-added members cannot inherit personal accounts, old consent or direct grants',
      async () => {
        const original = member.membershipId;
        const started = await f.begin();
        await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
          original,
        ]);
        await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
          randomUUID(),
          member.userId,
        ]);
        await assert.rejects(service.complete('code', started.state, 'test-session', member.userId), AccessDenied);
        await assert.rejects(service.status(one.id, member.userId, started.accountId), AccessDenied);
        assert.equal((await service.list(one.id, member.userId)).accounts.length, 0);
      },
    );
  } finally {
    await f.close();
  }
});

test('account reservation bounds serialize concurrent creators and allow reconnect at capacity', async t => {
  const f = await accountFixture();
  const accounts = f.table('tf_atlassian_accounts');
  const insert = async (count, ownership, owner = null) => {
    await f.db.platform.query(
      `INSERT INTO ${accounts} (id,protocol,ownership,owner_membership_id,state,config_hash)
      SELECT gen_random_uuid(),'trello',$1,$2,'disconnected','fixture' FROM generate_series(1,$3)`,
      [ownership, owner, count],
    );
  };
  try {
    await t.test('personal reservations stop at twenty including abandoned and disconnected rows', async () => {
      await insert(19, 'personal', f.member.membershipId);
      const results = await Promise.allSettled([f.begin(), f.begin()]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(results.find(result => result.status === 'rejected').reason.code, 'account-limit-reached');
      const started = results.find(result => result.status === 'fulfilled').value;
      await f.service.disconnect(f.one.id, f.member.userId, started.accountId);
      await assert.rejects(f.begin(), /account-limit-reached/);
      const reconnected = await f.service.reconnect(f.one.id, f.member.userId, 'test-session', started.accountId);
      const completed = await f.service.complete(
        'test-code',
        new URL(reconnected.url).searchParams.get('state'),
        'test-session',
        f.member.userId,
      );
      assert.equal(completed.account.state, 'active');
      assert.equal((await f.service.list(f.one.id, f.member.userId)).accounts.length, 20);
    });
    await t.test('business reservations stop at twenty across administrators', async () => {
      await insert(19, 'business');
      const results = await Promise.allSettled([
        f.begin('trello', 'business', f.one.userId),
        f.begin('trello', 'business', f.one.userId),
      ]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(results.find(result => result.status === 'rejected').reason.code, 'account-limit-reached');
    });
    await t.test('workspace cap counts private accounts belonging to other memberships', async () => {
      const other = randomUUID();
      await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        other,
        randomUUID(),
      ]);
      await insert(59, 'personal', other);
      const results = await Promise.allSettled([
        f.begin('trello', 'personal', f.one.userId),
        f.begin('trello', 'personal', f.one.userId),
      ]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(results.find(result => result.status === 'rejected').reason.code, 'account-limit-reached');
      assert.equal(
        (await f.db.platform.query(`SELECT count(*)::integer AS count FROM ${accounts}`)).rows[0].count,
        100,
      );
    });
  } finally {
    await f.close();
  }
});
