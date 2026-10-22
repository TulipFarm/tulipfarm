import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { accountFixture } from '../../../packages/atlassian/test/account-fixture.mjs';
import { authConfig } from '../src/auth.ts';
import { registerAtlassianAccounts } from '../src/atlassian-accounts.ts';
import { atlassianAccounts } from '../src/atlassian-composition.ts';

test('account HTTP routes use real service and restricted PostgreSQL behind authenticated sessions', async t => {
  const f = await accountFixture();
  const logs = [];
  const app = Fastify({ logger: { level: 'trace', stream: { write: line => logs.push(line) } } });
  const origin = authConfig().webOrigin;
  const member = { cookie: 'session=member', origin };
  const admin = { cookie: 'session=admin', origin };
  const sessions = new Map([
    [member.cookie, { user: { id: f.member.userId }, session: { id: 'member-session' } }],
    [admin.cookie, { user: { id: f.one.userId }, session: { id: 'admin-session' } }],
    ['session=other', { user: { id: f.member.userId }, session: { id: 'other-session' } }],
    ['session=outsider', { user: { id: randomUUID() }, session: { id: 'outsider-session' } }],
  ]);
  const auth = { api: { getSession: async ({ headers }) => sessions.get(headers.get('cookie')) ?? null } };
  const base = `/v1/workspaces/${f.one.id}/atlassian/accounts`;
  const callback = '/v1/atlassian/oauth/callback';
  const body = { protocol: 'trello', ownership: { kind: 'personal' } };
  const request = async (options, status, expected) => {
    const response = await app.inject({ headers: member, ...options });
    assert.equal(
      response.statusCode,
      status,
      `${options.method ?? 'GET'} ${options.url.split('?')[0]}: ${response.body}`,
    );
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    const value = response.json();
    if (expected !== undefined) assert.deepEqual(value, expected);
    return value;
  };
  const begin = async (payload = body, headers = member, url = base) => {
    const value = await request({ method: 'POST', url: `${url}/begin`, headers, payload }, 200);
    return { ...value, state: new URL(value.url).searchParams.get('state') };
  };
  const complete = (started, headers = member, status = 200, query = { code: 'private-callback-code' }) =>
    request({ url: `${callback}?${new URLSearchParams({ state: started.state, ...query })}`, headers }, status);
  const denied = { error: 'account-not-found' };
  try {
    await app.register(swagger, {
      openapi: { openapi: '3.0.3', info: { title: 'Account integration', version: '1' } },
    });
    await app.register(async routes => registerAtlassianAccounts(routes, auth, f.service), { prefix: '/v1' });
    await app.ready();

    await t.test('all routes authenticate and unsafe methods require the trusted origin', async () => {
      const item = `${base}/${randomUUID()}`;
      const unsafe = [
        { method: 'POST', url: `${base}/begin`, payload: body },
        { method: 'POST', url: `${item}/reconnect` },
        { method: 'POST', url: `${item}/disconnect` },
        { method: 'PUT', url: `${item}/grants`, payload: { expectedVersion: 1, memberIds: [], teamIds: [] } },
      ];
      for (const route of unsafe)
        for (const headers of [{ cookie: member.cookie }, { cookie: member.cookie, origin: 'https://foreign.example' }])
          await request({ ...route, headers }, 403, { error: 'untrusted-origin' });
      for (const route of [...unsafe, { url: base }, { url: item }, { url: `${item}/grants` }, { url: callback }])
        await request({ ...route, headers: { origin } }, 401, { error: 'sign-in-required' });
      await request({ url: base, headers: { cookie: 'session=outsider' } }, 404, denied);
      assert.equal(f.calls.length, 0);
    });

    await t.test('disabled composition and missing protocol configuration fail closed', async () => {
      assert.equal(atlassianAccounts(undefined, {}), null);
      assert.equal(atlassianAccounts(f.runtime, {}), null);
      for (const service of [null, f.makeService({ configurations: {} })]) {
        const disabled = Fastify();
        try {
          registerAtlassianAccounts(disabled, auth, service);
          const url = `/workspaces/${f.one.id}/atlassian/accounts`;
          const response = await disabled.inject({
            method: 'POST',
            url: `${url}/begin`,
            headers: member,
            payload: body,
          });
          assert.equal(response.statusCode, 503);
          assert.deepEqual(response.json(), { error: 'account-disabled' });
          const list = await disabled.inject({ url, headers: member });
          assert.equal(list.statusCode, service ? 200 : 503);
          if (service)
            assert.deepEqual(list.json(), {
              accounts: [],
              providers: ['atlassian-mcp', 'atlassian-rest', 'trello'].map(protocol => ({
                protocol,
                configured: false,
              })),
            });
        } finally {
          await disabled.close();
        }
      }
    });

    let privateAccount;
    await t.test('success canonicalizes UUIDs, consumes state once and returns credential-free metadata', async () => {
      privateAccount = await begin(body, member, base.replace(f.one.id, f.one.id.toUpperCase()));
      assert.equal(privateAccount.state.slice(0, 36), f.one.id);
      assert.deepEqual(await complete(privateAccount, { cookie: 'session=other' }, 404), denied);
      assert.deepEqual(await complete(privateAccount, admin, 404), denied);
      assert.equal(f.calls.length, 0);
      const completed = await complete(privateAccount);
      assert.equal(completed.workspaceId, f.one.id);
      assert.equal(completed.account.state, 'active');
      assert.deepEqual(completed.account.identity, {
        id: 'abcdef123456abcdef123456',
        label: 'test-person',
        qualification: 'verified',
      });
      assert.deepEqual(completed.account.capabilities, { read: true, manage: true, use: true });
      assert.equal(
        await f.service.withAccessToken(
          f.one.id.toUpperCase(),
          f.member.userId,
          privateAccount.accountId.toUpperCase(),
          async token => token.accessToken === 'synthetic-access-token',
        ),
        true,
      );
      const calls = f.calls.length;
      assert.deepEqual(await complete(privateAccount, member, 404), denied);
      assert.equal(f.calls.length, calls);
      const status = await request({ url: `${base}/${privateAccount.accountId}` }, 200);
      const list = await request({ url: base }, 200);
      assert.deepEqual(status, completed.account);
      assert.deepEqual(list.accounts, [status]);
      for (const value of [completed, status, list])
        for (const secret of [
          'synthetic-access-token',
          'synthetic-refresh-token',
          'test-secret',
          'private-callback-code',
          privateAccount.state,
          'credential',
          'config_hash',
          'verifier',
        ])
          assert.equal(JSON.stringify(value).includes(secret), false);
      const stored = (
        await f.db.platform.query(`SELECT credential FROM ${f.table('tf_atlassian_accounts')} WHERE id=$1`, [
          privateAccount.accountId,
        ])
      ).rows[0];
      assert.ok(stored.credential.ciphertext);
      assert.equal(JSON.stringify(stored).includes('synthetic-'), false);
    });

    await t.test(
      'admins cannot list, read, reconnect, disconnect or grant another member personal account',
      async () => {
        assert.deepEqual((await request({ url: base, headers: admin }, 200)).accounts, []);
        const item = `${base}/${privateAccount.accountId}`;
        for (const route of [
          { url: item },
          { url: `${item}/grants` },
          { method: 'POST', url: `${item}/reconnect` },
          { method: 'POST', url: `${item}/disconnect` },
          { method: 'PUT', url: `${item}/grants`, payload: { expectedVersion: 1, memberIds: [], teamIds: [] } },
        ])
          await request({ ...route, headers: admin }, 404, denied);
      },
    );

    await t.test('strict validators reject extra properties, coercion, arrays and ambiguous callbacks', async () => {
      for (const payload of [
        { ...body, credential: 'injected' },
        { ...body, ownership: { kind: 'personal', ownerId: f.one.userId } },
        { ...body, protocol: ['trello'] },
      ])
        await request({ method: 'POST', url: `${base}/begin`, payload }, 400, { error: 'invalid-request' });
      const started = await begin();
      const queries = [
        { code: 'private-callback-code' },
        { state: started.state },
        { code: 'private-callback-code', state: 'invalid-state' },
        { code: 'private-callback-code', error: 'access_denied', state: started.state },
        { code: 'private-callback-code', state: started.state, extra: 'unexpected' },
      ];
      for (const query of queries)
        await request({ url: `${callback}?${new URLSearchParams(query)}` }, 400, { error: 'invalid-request' });
      await request({ url: `${callback}?code=one&code=two&state=${started.state}` }, 400, { error: 'invalid-request' });
      await complete(started);
    });

    await t.test(
      'provider denial consumes only the initiating session state without exchanging or reflecting diagnostics',
      async () => {
        const started = await begin();
        const query = {
          error: 'access_denied',
          error_description: 'private-denial-diagnostic',
          error_uri: 'https://attacker.example/private-denial-diagnostic',
        };
        const calls = f.calls.length;
        assert.deepEqual(await complete(started, { cookie: 'session=other' }, 404, query), denied);
        assert.deepEqual(await complete(started, member, 400, query), { error: 'account-authorization-denied' });
        assert.deepEqual(await complete(started, member, 404, query), denied);
        assert.deepEqual(await complete(started, member, 404), denied);
        assert.equal(f.calls.length, calls);
        const stored = (
          await f.db.platform.query(
            `SELECT a.state, a.credential, t.state AS attempt_state, t.verifier FROM ${f.table('tf_atlassian_accounts')} a JOIN ${f.table('tf_atlassian_account_attempts')} t ON t.account_id=a.id WHERE a.id=$1`,
            [started.accountId],
          )
        ).rows[0];
        assert.deepEqual(stored, {
          state: 'reconnect-required',
          credential: null,
          attempt_state: 'consumed',
          verifier: null,
        });
      },
    );

    await t.test('business grants reject numeric coercion and give admins only explicit access', async () => {
      const started = await begin({ ...body, ownership: { kind: 'business' } });
      const completed = await complete(started);
      assert.deepEqual(completed.account.capabilities, { read: true, manage: true, use: true });
      const item = `${base}/${started.accountId}`;
      const url = `${item}/grants`;
      const managers = { memberIds: [f.member.membershipId], teamIds: [] };
      await request({ url: item, headers: admin }, 404, denied);
      const grants = { expectedVersion: 1, memberIds: [], teamIds: [f.teamId] };
      for (const payload of [
        { ...grants, expectedVersion: '1' },
        { ...grants, memberIds: f.member.membershipId },
        { ...grants, extra: true },
      ])
        await request({ method: 'PUT', url, payload }, 400, { error: 'invalid-request' });
      await request({ url }, 200, { expectedVersion: 1, memberIds: [f.member.membershipId], teamIds: [], managers });
      await request({ method: 'PUT', url, payload: grants }, 200);
      await request({ method: 'PUT', url, payload: grants }, 409, { error: 'account-conflict' });
      await request({ url }, 200, { ...grants, expectedVersion: 2, managers });
      await request(
        { method: 'PUT', url, payload: { expectedVersion: 2, memberIds: [f.one.membershipId], teamIds: [] } },
        200,
      );
      assert.deepEqual((await request({ url: item, headers: admin }, 200)).capabilities, {
        read: true,
        manage: false,
        use: true,
      });
      await request({ method: 'POST', url: `${item}/disconnect`, headers: admin }, 404, denied);
      const disconnected = await request({ method: 'POST', url: `${item}/disconnect` }, 200);
      assert.equal(disconnected.account.state, 'disconnected');
      assert.equal(disconnected.providerRevocation, 'manual-required');
    });

    await t.test('a denial cannot overwrite an already claimed successful exchange', async () => {
      const started = await begin();
      let entered;
      let release;
      const ready = new Promise(resolve => {
        entered = resolve;
      });
      const blocked = new Promise(resolve => {
        release = resolve;
      });
      f.setBehavior(async (url, init) => {
        if (url.endsWith('/token')) {
          entered();
          await blocked;
        }
        return f.defaultBehavior(url, init);
      });
      const pending = complete(started);
      try {
        await ready;
        assert.deepEqual(await complete(started, member, 404, { error: 'access_denied' }), denied);
      } finally {
        release();
        f.setBehavior(f.defaultBehavior);
      }
      assert.equal((await pending).account.state, 'active');
    });

    await t.test('reconnect fences old state and exchange failures return sanitized recovery responses', async () => {
      const started = await begin();
      const next = await request({ method: 'POST', url: `${base}/${started.accountId}/reconnect` }, 200);
      assert.deepEqual(await complete(started, member, 404), denied);
      f.setBehavior(async () => {
        throw new Error('synthetic-access-token private-provider-diagnostic');
      });
      assert.deepEqual(await complete({ state: new URL(next.url).searchParams.get('state') }, member, 409), {
        error: 'account-reconnect-required',
      });
      assert.equal((await request({ url: `${base}/${started.accountId}` }, 200)).state, 'reconnect-required');
      f.setBehavior(f.defaultBehavior);
    });

    await t.test(
      'reflected access, refresh, client secret and escaped metadata never reach persistence or responses',
      async () => {
        const started = await begin({ ...body, protocol: 'atlassian-rest' });
        for (const reflection of [
          'synthetic-access-token',
          'synthetic-refresh-token',
          'test-secret',
          'private-callback-code',
          '%2573ynthetic-access-token',
          '\\u0073ynthetic-refresh-token',
          '&#x74;est-secret',
        ]) {
          const next = await request({ method: 'POST', url: `${base}/${started.accountId}/reconnect` }, 200);
          f.setBehavior(async (url, init) =>
            url.endsWith('/me')
              ? Response.json({ account_id: 'verified-id', name: reflection })
              : f.defaultBehavior(url, init),
          );
          assert.deepEqual(await complete({ state: new URL(next.url).searchParams.get('state') }, member, 409), {
            error: 'account-reconnect-required',
          });
          const stored = (
            await f.db.platform.query(
              `SELECT identity, credential, resources FROM ${f.table('tf_atlassian_accounts')} WHERE id=$1`,
              [started.accountId],
            )
          ).rows[0];
          assert.deepEqual(stored, { identity: null, credential: null, resources: [] });
        }
        f.setBehavior(f.defaultBehavior);
      },
    );

    await t.test('Swagger documents every success shape and denial without arbitrary response properties', async () => {
      const paths = app.swagger().paths;
      const root = '/v1/workspaces/{workspaceId}/atlassian/accounts';
      const expected = [
        [root, 'get', ['accounts', 'providers']],
        [`${root}/begin`, 'post', ['accountId', 'url']],
        [
          `${root}/{accountId}`,
          'get',
          [
            'id',
            'protocol',
            'ownership',
            'state',
            'configured',
            'identity',
            'resources',
            'scopes',
            'generation',
            'grantsVersion',
            'capabilities',
          ],
        ],
        [`${root}/{accountId}/reconnect`, 'post', ['accountId', 'url']],
        [`${root}/{accountId}/disconnect`, 'post', ['account', 'providerRevocation']],
        [`${root}/{accountId}/grants`, 'get', ['expectedVersion', 'memberIds', 'teamIds'], ['managers']],
        [
          `${root}/{accountId}/grants`,
          'put',
          [
            'id',
            'protocol',
            'ownership',
            'state',
            'configured',
            'identity',
            'resources',
            'scopes',
            'generation',
            'grantsVersion',
            'capabilities',
          ],
        ],
        [callback, 'get', ['workspaceId', 'account']],
      ];
      for (const [path, method, keys, optional = []] of expected) {
        const response = paths[path][method].responses['200'].content['application/json'].schema;
        assert.equal(response.additionalProperties, false);
        assert.deepEqual(Object.keys(response.properties), [...keys, ...optional]);
        assert.deepEqual(response.required, keys);
        assert.equal(JSON.stringify(response).includes('"additionalProperties":true'), false);
      }
      const metadata = paths[`${root}/{accountId}`].get.responses['200'].content['application/json'].schema;
      assert.deepEqual(metadata.properties.state.enum, [
        'authorizing',
        'active',
        'refreshing',
        'reconnect-required',
        'disconnected',
      ]);
      assert.equal(metadata.properties.capabilities.properties.use.type, 'boolean');
      assert.equal(
        paths[`${root}/{accountId}/grants`].put.requestBody.content['application/json'].schema.properties
          .expectedVersion.type,
        'integer',
      );
    });

    await t.test('callback secrets are absent from trace-level request and error logs', async () => {
      app.log.info('account-log-probe');
      const output = logs.join('');
      assert.ok(output.includes('account-log-probe'));
      for (const secret of [
        privateAccount.state,
        'private-callback-code',
        'private-denial-diagnostic',
        'private-provider-diagnostic',
        'synthetic-access-token',
        'synthetic-refresh-token',
      ])
        assert.equal(output.includes(secret), false);
    });

    await t.test('account capacity is an actionable HTTP conflict and existing accounts remain readable', async () => {
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_atlassian_accounts')} (id,protocol,ownership,owner_membership_id,state,config_hash)
        SELECT gen_random_uuid(),'trello','personal',$1,'disconnected','fixture' FROM generate_series(1,
          20-(SELECT count(*)::integer FROM ${f.table('tf_atlassian_accounts')} WHERE owner_membership_id=$1))`,
        [f.member.membershipId],
      );
      await request({ method: 'POST', url: `${base}/begin`, payload: body }, 409, { error: 'account-limit-reached' });
      assert.equal((await request({ url: `${base}/${privateAccount.accountId}` }, 200)).state, 'active');
    });
  } finally {
    await app.close();
    await f.close();
  }
});
