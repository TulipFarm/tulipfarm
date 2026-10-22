import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { GitHubCredentialRejected, githubCompatibility } from '@tulipfarm/github';
import { credentialCipher } from '../src/credentials.ts';
import { githubFixture } from './fixture.mjs';

test('private multi-account lifecycle, consent fencing and credential access in PostgreSQL', async t => {
  const f = await githubFixture();
  const { service, one, two, member, table, db } = f;
  let first;
  try {
    await t.test('restricted SQL denies cross-workspace access and ownership rewrites', async () => {
      for (const sql of [
        `SELECT * FROM ${table('tf_github_accounts', two)}`,
        'SELECT * FROM app.accounts',
        `UPDATE ${table('tf_github_accounts')} SET owner_membership_id=gen_random_uuid()`,
        `DELETE FROM ${table('tf_github_accounts')}`,
        `ALTER TABLE ${table('tf_github_accounts')} ADD COLUMN evil text`,
      ])
        await assert.rejects(
          f.runtime.transaction(one.id, githubCompatibility, tx => tx.client.query(sql)),
          error => error.code === '42501',
        );
    });
    await t.test('consent is hashed, encrypted and consumed once by the initiating member and session', async () => {
      first = await f.begin();
      const stored = (
        await db.platform.query(`SELECT * FROM ${table('tf_github_account_attempts')} WHERE account_id=$1`, [
          first.accountId,
        ])
      ).rows[0];
      const verifier = credentialCipher(f.keyring).decrypt(
        {
          workspaceId: one.id,
          accountId: first.accountId,
          membershipId: member.membershipId,
          generation: 1,
          purpose: 'pkce',
        },
        stored.verifier,
      );
      assert.equal(
        new URL(first.url).searchParams.get('code_challenge'),
        createHash('sha256').update(verifier).digest('base64url'),
      );
      for (const secret of [first.state, 'test-session', verifier])
        assert.equal(JSON.stringify(stored).includes(secret), false);
      await assert.rejects(
        service.complete({ code: 'fixture-code', state: first.state }, 'wrong-session', member.userId),
        AccessDenied,
      );
      await assert.rejects(f.complete(first, one.userId), AccessDenied);
      await assert.rejects(f.complete({ state: first.state.replace(one.id, two.id) }), AccessDenied);
      assert.equal(f.calls.length, 0);
      const results = await Promise.allSettled([f.complete(first), f.complete(first)]);
      assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
      assert.equal(f.calls.filter(([url]) => url.endsWith('/access_token')).length, 1);
      assert.equal(new URLSearchParams(f.calls[0][1].body).get('code_verifier'), verifier);
      await assert.rejects(f.complete(first));
      assert.equal((await service.status(one.id, member.userId, first.accountId)).identity.id, '123');
      const raw = JSON.stringify((await db.platform.query(`SELECT * FROM ${table('tf_github_accounts')}`)).rows);
      assert.equal(raw.includes('synthetic-access-token'), false);
    });
    await t.test('multiple identities remain private even from administrators', async () => {
      const second = await f.connect(456);
      assert.deepEqual(
        (await service.list(one.id, member.userId)).accounts.map(account => account.identity.id),
        ['123', '456'],
      );
      assert.deepEqual((await service.list(one.id, one.userId)).accounts, []);
      for (const action of [
        () => service.status(one.id, one.userId, second),
        () => service.reconnect(one.id, one.userId, 'admin-session', second),
        () => service.disconnect(one.id, one.userId, second),
        () => service.withCredential(one.id, one.userId, second, async () => assert.fail()),
      ])
        await assert.rejects(action(), AccessDenied);
      await assert.rejects(service.status(two.id, two.userId, second), AccessDenied);
      assert.deepEqual(
        await service.withCredential(
          one.id,
          member.userId,
          second,
          async ({ accessToken, identity, generation, accountId, membershipId }) => ({
            tokenMatches: accessToken === 'synthetic-access-token',
            identity,
            generation,
            accountId,
            membershipId,
          }),
        ),
        {
          tokenMatches: true,
          identity: { id: '456', login: 'person-456' },
          generation: 1,
          accountId: second,
          membershipId: member.membershipId,
        },
      );
      await assert.rejects(f.connect(456), /reconnect-required/);
    });
    await t.test('reconnect keeps numeric identity, accepts renamed login and rejects identity switching', async () => {
      const reconnect = async () => {
        const next = await service.reconnect(one.id, member.userId, 'test-session', first.accountId);
        return { state: new URL(next.url).searchParams.get('state') };
      };
      f.setProfile({ id: 999, login: 'wrong-person' });
      await assert.rejects(f.complete(await reconnect()), /reconnect-required/);
      assert.equal((await service.status(one.id, member.userId, first.accountId)).identity.id, '123');
      f.setProfile({ id: 123, login: 'renamed-person' });
      await f.complete(await reconnect());
      const status = await service.status(one.id, member.userId, first.accountId);
      assert.deepEqual(status.identity, { id: '123', login: 'renamed-person' });
      assert.equal(status.generation, 3);
      await assert.rejects(
        service.withCredential(one.id, member.userId, first.accountId, async () => assert.fail(), 1),
        /reconnect-required/,
      );
    });
    await t.test('expiry, denial, reconnect and disconnect fence old callbacks', async () => {
      const expired = await f.begin();
      await db.platform.query(
        `UPDATE ${table('tf_github_account_attempts')} SET expires_at=clock_timestamp()-interval '1 minute' WHERE account_id=$1`,
        [expired.accountId],
      );
      await assert.rejects(f.complete(expired), AccessDenied);
      const denied = await f.begin();
      await assert.rejects(
        service.complete({ state: denied.state, error: 'access_denied' }, 'test-session', member.userId),
        /authorization-denied/,
      );
      await assert.rejects(f.complete(denied), AccessDenied);
      const old = await f.begin();
      const next = await service.reconnect(one.id, member.userId, 'test-session', old.accountId);
      await assert.rejects(f.complete(old), AccessDenied);
      await service.disconnect(one.id, member.userId, old.accountId);
      await assert.rejects(f.complete({ state: new URL(next.url).searchParams.get('state') }), AccessDenied);
    });
    await t.test('disconnect during token exchange cannot resurrect an account', async () => {
      const started = await f.begin();
      let release, entered;
      const ready = new Promise(resolve => {
        entered = resolve;
      });
      const blocked = new Promise(resolve => {
        release = resolve;
      });
      f.setBehavior(async (url, init) => {
        if (url.endsWith('/access_token')) {
          entered();
          await blocked;
        }
        return f.defaultBehavior(url, init);
      });
      const pending = f.complete(started);
      await ready;
      await service.disconnect(one.id, member.userId, started.accountId);
      release();
      await assert.rejects(pending, /reconnect-required/);
      assert.equal((await service.status(one.id, member.userId, started.accountId)).state, 'disconnected');
      f.setBehavior(f.defaultBehavior);
    });
    await t.test('credential revocation persists and stops subsequent provider calls; no refresh replay', async () => {
      let calls = 0;
      await assert.rejects(
        service.withCredential(one.id, member.userId, first.accountId, async () => {
          calls++;
          throw new GitHubCredentialRejected();
        }),
        /reconnect-required/,
      );
      await assert.rejects(
        service.withCredential(one.id, member.userId, first.accountId, async () => {
          calls++;
        }),
        /reconnect-required/,
      );
      assert.equal(calls, 1);
      const stored = (
        await db.platform.query(`SELECT credential,state FROM ${table('tf_github_accounts')} WHERE id=$1`, [
          first.accountId,
        ])
      ).rows[0];
      assert.deepEqual(stored, { credential: null, state: 'reconnect-required' });
      const id = await f.connect(789);
      await db.platform.query(
        `UPDATE ${table('tf_github_accounts')} SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
        [id],
      );
      await assert.rejects(
        service.withCredential(one.id, member.userId, id, async () => assert.fail()),
        /reconnect-required/,
      );
      assert.equal((await service.status(one.id, member.userId, id)).state, 'reconnect-required');
    });
    await t.test('a removed and re-added member cannot inherit personal accounts or consent', async () => {
      const started = await f.begin();
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
        member.membershipId,
      ]);
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        randomUUID(),
        member.userId,
      ]);
      await assert.rejects(f.complete(started), AccessDenied);
      assert.deepEqual((await service.list(one.id, member.userId)).accounts, []);
    });
  } finally {
    await f.close();
  }
});

test('credential calls serialize with disconnect and configuration changes fail closed', async () => {
  const f = await githubFixture();
  try {
    const id = await f.connect();
    const disabled = f.makeService({ configuration: null, keyring: null });
    assert.equal((await disabled.list(f.one.id, f.member.userId)).configured, false);
    await assert.rejects(
      disabled.withCredential(f.one.id, f.member.userId, id, async () => assert.fail()),
      /account-disabled/,
    );
    const changed = f.makeService({ configuration: { ...f.configuration, clientSecret: 'rotated-secret' } });
    assert.equal((await changed.status(f.one.id, f.member.userId, id)).state, 'reconnect-required');
    await assert.rejects(
      changed.withCredential(f.one.id, f.member.userId, id, async () => assert.fail()),
      /reconnect-required/,
    );
    const next = await f.service.reconnect(f.one.id, f.member.userId, 'test-session', id);
    await f.complete({ state: new URL(next.url).searchParams.get('state') });
    let entered, release;
    const ready = new Promise(resolve => {
      entered = resolve;
    });
    const blocked = new Promise(resolve => {
      release = resolve;
    });
    const call = f.service.withCredential(f.one.id, f.member.userId, id, async () => {
      entered();
      await blocked;
      return 'provider-result';
    });
    await ready;
    let disconnected = false;
    const disconnect = disabled.disconnect(f.one.id, f.member.userId, id).then(value => {
      disconnected = true;
      return value;
    });
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(disconnected, false);
    release();
    assert.equal(await call, 'provider-result');
    assert.equal((await disconnect).account.state, 'disconnected');
    await assert.rejects(
      f.service.withCredential(f.one.id, f.member.userId, id, async () => assert.fail()),
      /reconnect-required/,
    );
  } finally {
    await f.close();
  }
});

test('account limits serialize concurrent creation and permit recovery at capacity', async () => {
  const f = await githubFixture();
  try {
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_github_accounts')} (id,owner_membership_id,state,config_hash) SELECT gen_random_uuid(),$1,'disconnected','fixture' FROM generate_series(1,19)`,
      [f.member.membershipId],
    );
    const attempts = await Promise.allSettled([f.begin(), f.begin()]);
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(attempts.find(result => result.status === 'rejected').reason.code, 'account-limit-reached');
    const started = attempts.find(result => result.status === 'fulfilled').value;
    const next = await f.service.reconnect(f.one.id, f.member.userId, 'test-session', started.accountId);
    await f.complete({ state: new URL(next.url).searchParams.get('state') });
    assert.equal((await f.service.list(f.one.id, f.member.userId)).accounts.length, 20);
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_github_accounts')} (id,owner_membership_id,state,config_hash) SELECT gen_random_uuid(),$1,'disconnected','fixture' FROM generate_series(1,80)`,
      [f.one.membershipId],
    );
    await assert.rejects(f.service.begin(f.one.id, f.one.userId, 'admin-session'), /account-limit-reached/);
  } finally {
    await f.close();
  }
});
