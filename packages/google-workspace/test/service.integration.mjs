import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied, lockAuthorization } from '@tulipfarm/access';
import { createGoogleWorkspaceService } from '../src/service.ts';
import { googleAppScopes, googleIdentityScopes } from '../src/contracts.ts';
import { googleFixture } from './fixture.mjs';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

test('OAuth persists encrypted personal credentials and rejects admin borrowing, replay and wrong sessions', async () => {
  const f = await googleFixture();
  try {
    assert.deepEqual(f.service.availability(), { configured: true });
    const { state, url } = await f.begin();
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('prompt'), 'consent select_account');
    assert.equal(url.searchParams.get('include_granted_scopes'), 'true');
    const callback = { state, code: 'private-code' };
    await assert.rejects(f.service.complete({ ...f.principal, sessionId: randomUUID() }, callback), {
      message: 'invalid-state',
    });
    await assert.rejects(f.service.complete({ userId: f.admin.userId, sessionId: f.principal.sessionId }, callback), {
      message: 'invalid-state',
    });
    assert.equal(f.calls.length, 0);
    const status = await f.service.complete(f.principal, callback);
    assert.equal(status.status, 'connected');
    assert.equal(status.accountId, 'google-account-1');
    await assert.rejects(f.service.complete(f.principal, callback), { message: 'invalid-state' });
    assert.deepEqual(await f.service.status(f.workspace.id, f.admin.userId), { status: 'disconnected' });
    const row = (
      await f.db.platform.query(`SELECT * FROM ${f.table('tf_google_integrations')} WHERE id=$1`, [
        status.integrationId,
      ])
    ).rows[0];
    assert.equal(JSON.stringify(row).includes('private-access'), false);
    assert.equal(JSON.stringify(row).includes('private-refresh'), false);
    assert.equal((await f.db.platform.query(`SELECT * FROM ${f.table('tf_google_oauth_states')}`)).rowCount, 0);
    await assert.rejects(
      f.service.withCredential({ ...f.fence(status), actor: f.admin }, async () =>
        assert.fail('borrowed member token'),
      ),
      { message: 'stale-integration' },
    );
    assert.equal(
      await f.service.withCredential(f.fence(status), async credential => credential.accessToken),
      'initial-private-access',
    );
    await f.service.disconnect(f.workspace.id, f.admin.userId);
    assert.equal((await f.service.status(f.workspace.id, f.member.userId)).status, 'connected');
  } finally {
    await f.close();
  }
});

test('state expires, denial is consumed, superseded attempts fail, and missing refresh or scopes cannot connect', async () => {
  const f = await googleFixture();
  try {
    const old = await f.begin();
    const next = await f.begin();
    await assert.rejects(f.service.complete(f.principal, { state: old.state, code: 'x' }), {
      message: 'invalid-state',
    });
    f.advance(600001);
    await assert.rejects(f.service.complete(f.principal, { state: next.state, code: 'x' }), {
      message: 'invalid-state',
    });
    const denial = await f.begin();
    await assert.rejects(f.service.complete(f.principal, { state: denial.state, error: 'private-denial' }), {
      message: 'consent-denied',
    });
    await assert.rejects(f.service.complete(f.principal, { state: denial.state, code: 'x' }), {
      message: 'invalid-state',
    });
    for (const [behavior, message] of [
      [{ noRefresh: true }, 'reconnect-required'],
      [{ scopes: ['openid'] }, 'insufficient-scope'],
      [{ throw: true }, 'provider-unavailable'],
    ]) {
      f.behavior(behavior);
      const attempt = await f.begin();
      await assert.rejects(f.service.complete(f.principal, { state: attempt.state, code: 'x' }), { message });
      await assert.rejects(f.service.complete(f.principal, { state: attempt.state, code: 'x' }), {
        message: 'invalid-state',
      });
      assert.deepEqual(await f.service.status(f.workspace.id, f.member.userId), { status: 'disconnected' });
    }
  } finally {
    await f.close();
  }
});

test('refresh is serialized across service instances and preserves omitted and rotated refresh tokens', async () => {
  const f = await googleFixture();
  try {
    const status = await f.connect();
    const other = createGoogleWorkspaceService(f.serviceOptions);
    f.advance(3600000);
    const results = await Promise.all(
      [f.service, other].map(service =>
        service.withCredential(f.fence(status), async credential => credential.accessToken),
      ),
    );
    assert.deepEqual(results, ['refreshed-private-access', 'refreshed-private-access']);
    assert.equal(f.calls.filter(call => call.init.body?.get('grant_type') === 'refresh_token').length, 1);
    f.advance(3600000);
    f.behavior({ rotatedRefresh: 'rotated-private-refresh' });
    await f.service.withCredential(f.fence(status), async () => 'ok');
    f.advance(3600000);
    f.behavior({});
    await f.service.withCredential(f.fence(status), async () => 'ok');
    const refreshes = f.calls.filter(call => call.init.body?.get('grant_type') === 'refresh_token');
    assert.equal(refreshes[1].init.body.get('refresh_token'), 'private-refresh');
    assert.equal(refreshes[2].init.body.get('refresh_token'), 'rotated-private-refresh');
  } finally {
    await f.close();
  }
});

test('transient refresh errors retain credentials, invalid grant requires reconnect, and reduced scopes deny only missing access', async () => {
  const f = await googleFixture();
  try {
    let status = await f.connect();
    f.advance(3600000);
    const before = (
      await f.db.platform.query(`SELECT credential, generation FROM ${f.table('tf_google_integrations')}`)
    ).rows[0];
    for (const behavior of [
      { refreshError: 'server_error', refreshStatus: 503 },
      { refreshError: 'invalid_grant', refreshStatus: 503 },
      { refreshError: 'invalid_grant', refreshStatus: 429 },
      { throw: true },
      { timeout: true },
      { malformed: true },
    ]) {
      f.behavior(behavior);
      await assert.rejects(
        f.service.withCredential(f.fence(status), async () => assert.fail('expired access')),
        { message: 'provider-unavailable' },
      );
      assert.equal((await f.service.status(f.workspace.id, f.member.userId)).status, 'connected');
      assert.deepEqual(
        (await f.db.platform.query(`SELECT credential, generation FROM ${f.table('tf_google_integrations')}`)).rows[0],
        before,
      );
    }
    f.behavior({});
    await f.service.withCredential(f.fence(status), async ({ accessToken }) =>
      assert.equal(accessToken, 'refreshed-private-access'),
    );
    f.advance(3600000);
    f.behavior({ refreshError: 'invalid_grant' });
    await assert.rejects(
      f.service.withCredential(f.fence(status), async () => assert.fail('revoked')),
      { message: 'reconnect-required' },
    );
    assert.equal((await f.service.status(f.workspace.id, f.member.userId)).status, 'reconnect-required');
    assert.equal(
      (await f.db.platform.query(`SELECT credential FROM ${f.table('tf_google_integrations')}`)).rows[0].credential,
      null,
    );
    f.behavior({});
    status = await f.connect();
    f.advance(3600000);
    f.behavior({ scopes: [...googleIdentityScopes, ...googleAppScopes.calendar] });
    await assert.rejects(
      f.service.withCredential(f.fence(status), async () => assert.fail('missing gmail.send')),
      { message: 'insufficient-scope' },
    );
    const reduced = await f.service.status(f.workspace.id, f.member.userId);
    assert.deepEqual(
      { status: reduced.status, generation: reduced.generation, scopes: reduced.scopes },
      {
        status: 'connected',
        generation: status.generation,
        scopes: [...googleIdentityScopes, ...googleAppScopes.calendar].sort(),
      },
    );
    assert.equal(
      await f.service.withCredential(
        { ...f.fence(status), requiredScopes: googleAppScopes.calendar },
        async ({ accessToken }) => accessToken,
      ),
      'refreshed-private-access',
    );
  } finally {
    await f.close();
  }
});

test('workspace UUID spelling does not change OAuth state or credential binding', async () => {
  const f = await googleFixture();
  try {
    const workspaceId = f.workspace.id.toUpperCase();
    const { authorizationUrl } = await f.service.begin(workspaceId, f.principal);
    const url = new URL(authorizationUrl);
    f.challenge(url.searchParams.get('code_challenge'));
    const state = url.searchParams.get('state');
    assert.equal(state.split('.')[0], f.workspace.id);
    const status = await f.service.complete(f.principal, { state, code: 'private-code' });
    assert.equal(status.status, 'connected');
    assert.deepEqual(await f.service.status(workspaceId, f.member.userId), status);
    assert.equal(
      await f.service.withCredential({ ...f.fence(status), workspaceId }, async ({ accessToken }) => accessToken),
      'initial-private-access',
    );
    assert.deepEqual(await f.service.disconnect(workspaceId, f.member.userId), { disconnected: true, revoked: true });
  } finally {
    await f.close();
  }
});

test('disconnect and membership removal fence callback completion, readmission cannot inherit old integrations', async () => {
  const f = await googleFixture();
  try {
    const original = await f.connect();
    const attempt = await f.begin();
    let release;
    const wait = new Promise(resolve => {
      release = resolve;
    });
    f.behavior({ wait });
    const pending = f.service.complete(f.principal, { state: attempt.state, code: 'private-code' });
    while (
      !f.calls.some(call => call.init.body?.get('code') === 'private-code' && call.init.body?.get('code_verifier'))
    )
      await new Promise(resolve => setTimeout(resolve, 1));
    await f.service.disconnect(f.workspace.id, f.member.userId);
    release();
    await assert.rejects(pending, { message: 'stale-integration' });
    await assert.rejects(
      f.service.withCredential(f.fence(original), async () => 'bad'),
      { message: 'stale-integration' },
    );
    f.behavior({});
    const connected = await f.connect();
    const removedAttempt = await f.begin();
    await f.runtime.transaction(f.workspace.id, commonCompatibility, async tx => {
      await lockAuthorization(tx, 'write');
      await tx.client.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [
        f.member.membershipId,
      ]);
    });
    await assert.rejects(
      f.service.withCredential(f.fence(connected), async () => 'bad'),
      AccessDenied,
    );
    await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
      randomUUID(),
      f.member.userId,
    ]);
    assert.deepEqual(await f.service.status(f.workspace.id, f.member.userId), { status: 'disconnected' });
    await assert.rejects(f.service.complete(f.principal, { state: removedAttempt.state, code: 'x' }), {
      message: 'invalid-state',
    });
  } finally {
    await f.close();
  }
});

test('expiry, account replacement, disconnect failure and tampering fail closed', async () => {
  const f = await googleFixture();
  try {
    f.behavior({ refreshLifetime: 10 });
    const old = await f.connect();
    f.advance(10001);
    assert.equal((await f.service.status(f.workspace.id, f.member.userId)).status, 'reconnect-required');
    f.behavior({ account: 'replacement-account' });
    const current = await f.connect();
    assert.equal(current.accountId, 'replacement-account');
    await assert.rejects(
      f.service.withCredential(f.fence(old), async () => 'bad'),
      { message: 'stale-integration' },
    );
    await assert.rejects(
      f.service.withCredential({ ...f.fence(current), requiredScopes: ['ungranted'] }, async () => 'bad'),
      { message: 'insufficient-scope' },
    );
    await f.db.platform.query(`UPDATE ${f.table('tf_google_integrations')} SET account_id='tampered' WHERE id=$1`, [
      current.integrationId,
    ]);
    await assert.rejects(f.service.status(f.workspace.id, f.member.userId), { message: 'credential-unavailable' });
    assert.deepEqual(await f.service.disconnect(f.workspace.id, f.member.userId), {
      disconnected: true,
      revoked: false,
    });
    assert.deepEqual(await f.service.status(f.workspace.id, f.member.userId), { status: 'disconnected' });
    assert.deepEqual(await f.service.disconnect(f.workspace.id, f.member.userId), {
      disconnected: true,
      revoked: true,
    });
  } finally {
    await f.close();
  }
});

test('connected consent for another Google account starts a new generation, so switching back never revives the old fence', async () => {
  const f = await googleFixture();
  try {
    const first = await f.connect();
    f.behavior({ account: 'other-account' });
    const other = await f.connect();
    f.behavior({});
    const back = await f.connect();
    assert.deepEqual(
      [first, other, back].map(status => [status.accountId, status.generation]),
      [
        ['google-account-1', 2],
        ['other-account', 3],
        ['google-account-1', 4],
      ],
    );
    assert.deepEqual(back.scopes, first.scopes);
    for (const old of [first, other])
      await assert.rejects(
        f.service.withCredential(f.fence(old), async () => assert.fail('revived fence')),
        { message: 'stale-integration' },
      );
    assert.equal(
      await f.service.withCredential(f.fence(back), async ({ accessToken }) => accessToken),
      'initial-private-access',
    );
    assert.deepEqual(await f.service.status(f.workspace.id, f.member.userId), back);
    await f.db.platform.query(`UPDATE ${f.table('tf_google_integrations')} SET generation=$1`, [first.generation]);
    await assert.rejects(f.service.status(f.workspace.id, f.member.userId), { message: 'credential-unavailable' });
  } finally {
    await f.close();
  }
});

test('one app connects alone, later apps add scopes without changing the generation, and denial keeps the integration', async () => {
  const f = await googleFixture();
  try {
    const calendar = [...googleIdentityScopes, ...googleAppScopes.calendar];
    f.behavior({ scopes: calendar });
    const { url, state } = await f.begin(undefined, 'calendar');
    assert.deepEqual(url.searchParams.get('scope').split(' ').sort(), [...calendar].sort());
    assert.equal(url.searchParams.get('include_granted_scopes'), 'true');
    const first = await f.service.complete(f.principal, { state, code: 'private-code' });
    assert.deepEqual(
      { status: first.status, scopes: first.scopes },
      { status: 'connected', scopes: [...calendar].sort() },
    );
    const calendarFence = { ...f.fence(first), requiredScopes: googleAppScopes.calendar };
    await assert.rejects(
      f.service.withCredential(f.fence(first), async () => assert.fail('gmail not granted')),
      { message: 'insufficient-scope' },
    );
    f.behavior({ scopes: [...calendar, ...googleAppScopes.gmail] });
    const added = await f.connect(undefined, 'gmail');
    assert.equal(added.generation, first.generation);
    assert.deepEqual(added.scopes, [...calendar, ...googleAppScopes.gmail].sort());
    assert.equal(
      await f.service.withCredential(calendarFence, async ({ accessToken }) => accessToken),
      'initial-private-access',
    );
    assert.equal(
      await f.service.withCredential(f.fence(added), async ({ accessToken }) => accessToken),
      'initial-private-access',
    );
    const denied = await f.begin(undefined, 'drive');
    await assert.rejects(f.service.complete(f.principal, { state: denied.state, error: 'access_denied' }), {
      message: 'consent-denied',
    });
    assert.deepEqual(await f.service.status(f.workspace.id, f.member.userId), added);
  } finally {
    await f.close();
  }
});
