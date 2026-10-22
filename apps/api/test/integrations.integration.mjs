import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { fixture } from '../../../packages/integrations/test/fixture.mjs';
import { authConfig } from '../src/auth.ts';
import { registerIntegrations } from '../src/integrations.ts';

test('integrations HTTP boundary with restricted workspace PostgreSQL', async t => {
  const f = await fixture();
  const app = Fastify();
  const origin = authConfig().webOrigin;
  const sessions = new Map([
    ['session=owner', { user: { id: f.creator.userId } }],
    ['session=admin', { user: { id: f.actor.userId } }],
    ['session=member', { user: { id: f.member.userId } }],
    ['session=outsider', { user: { id: randomUUID() } }],
  ]);
  const auth = { api: { getSession: async ({ headers }) => sessions.get(headers.get('cookie')) ?? null } };
  const base = `/v1/workspaces/${f.workspaceId}/integrations`;
  const item = `${base}/${f.input.id}`;
  const owner = { cookie: 'session=owner', origin };
  const admin = { cookie: 'session=admin', origin };
  const member = { cookie: 'session=member', origin };
  const sourceGrant = { teamId: f.teamId, sourceId: f.input.repositories[0].id };
  const metadata = {
    id: f.input.id,
    name: 'Triage',
    owningTeamId: f.teamId,
    enabled: true,
    generation: 1,
    grantsVersion: 1,
    capabilities: { read: true, use: true, manage: true, administer: true },
  };
  const expectedIssue = {
    number: 17,
    title: 'Issue title',
    body: 'Issue body',
    state: 'open',
    url: 'https://github.com/tulipfarm/fixture/issues/17',
  };
  const unsafeRoutes = [
    { method: 'POST', url: base, payload: f.input },
    { method: 'POST', url: `${base}/read-issue`, payload: f.request() },
    { method: 'POST', url: `${item}/rotate`, payload: { expectedGeneration: 1, token: 'blocked-token' } },
    { method: 'PATCH', url: item, payload: { name: 'Blocked rename' } },
    { method: 'PUT', url: `${item}/grants`, payload: { expectedGrantsVersion: 1, grants: [], sourceGrants: [] } },
    { method: 'PUT', url: `${item}/owner`, payload: { owningTeamId: f.otherTeamId } },
    { method: 'DELETE', url: item },
  ];
  async function request(options, status, expected) {
    const response = await app.inject(options);
    assert.equal(response.statusCode, status, `${options.method ?? 'GET'} ${options.url}: ${response.body}`);
    assert.equal(response.headers['cache-control'], 'no-store');
    const body = response.json();
    if (expected !== undefined) assert.deepEqual(body, expected);
    return body;
  }
  let expectedGrantsVersion = 1;
  const grants = (permissions, sourceGrants = []) => ({
    expectedGrantsVersion,
    grants: [{ teamId: f.teamId, permissions }],
    sourceGrants,
  });
  const setGrants = async payload => {
    const result = await request({ method: 'PUT', url: `${item}/grants`, headers: owner, payload }, 200);
    expectedGrantsVersion = result.grantsVersion;
    return result;
  };
  const readIssue = (headers, payload = f.request(), status = 200, expected = expectedIssue) =>
    request({ method: 'POST', url: `${base}/read-issue`, headers, payload }, status, expected);
  const denied = { error: 'integration-not-found' };

  try {
    await app.register(swagger, {
      openapi: { openapi: '3.0.3', info: { title: 'Integrations integration', version: '1' } },
    });
    await app.register(async routes => registerIntegrations(routes, { auth, service: f.service }), { prefix: '/v1' });
    await app.ready();

    await t.test('unsafe routes reject absent or foreign origins and every route requires a session', async () => {
      for (const route of unsafeRoutes) {
        for (const headers of [
          { cookie: owner.cookie },
          { cookie: owner.cookie, origin: 'https://untrusted.example' },
        ]) {
          await request({ ...route, headers }, 403, { error: 'untrusted-origin' });
        }
      }
      for (const route of [{ url: base }, { url: item }, ...unsafeRoutes]) {
        for (const headers of [{ origin }, { origin, cookie: 'session=expired' }]) {
          await request({ ...route, headers }, 401, { error: 'sign-in-required' });
        }
      }
      await request({ url: base, headers: { cookie: owner.cookie } }, 200, { integrations: [] });
      await request({ url: base, headers: { cookie: 'session=outsider' } }, 404, denied);
      assert.equal(f.calls.length, 0);
    });

    await t.test('creation persists encrypted credentials and HTTP only returns metadata', async () => {
      await request({ method: 'POST', url: base, headers: admin, payload: f.input }, 404, denied);
      await request(
        { method: 'POST', url: base, headers: owner, payload: { ...f.input, credential: 'injected-ciphertext' } },
        400,
        { error: 'invalid-request' },
      );
      await request({ method: 'POST', url: base, headers: owner, payload: f.input }, 200, metadata);
      await request({ method: 'POST', url: base, headers: owner, payload: f.input }, 200, metadata);
      await request(
        { method: 'POST', url: base, headers: owner, payload: { ...f.input, token: 'conflicting-token' } },
        409,
        { error: 'conflict' },
      );
      await request({ url: base, headers: owner }, 200, { integrations: [metadata] });
      await request({ url: item, headers: owner }, 200, {
        ...metadata,
        repositories: [{ ...f.input.repositories[0], canReadIssues: false }],
        grants: [],
        sourceGrants: [],
        personGrants: [{ memberId: f.creator.membershipId, permissions: ['manage', 'read', 'use'] }],
        sourcePersonGrants: [],
      });
      await request({ url: base, headers: admin }, 200, { integrations: [] });
      await request({ url: item, headers: admin }, 404, denied);
      await request(
        {
          method: 'PUT',
          url: `${item}/grants`,
          headers: admin,
          payload: {
            expectedGrantsVersion: 1,
            grants: [],
            sourceGrants: [],
            personGrants: [{ memberId: f.actor.membershipId, permissions: ['read', 'use', 'manage'] }],
          },
        },
        404,
        denied,
      );
      const stored = (
        await f.owner.query(`SELECT credential, generation FROM ${f.table('tf_integrations')} WHERE id = $1`, [
          f.input.id,
        ])
      ).rows[0];
      assert.equal(stored.generation, 1);
      assert.equal(typeof stored.credential.ciphertext, 'string');
      assert.notEqual(stored.credential.ciphertext, '');
      assert.equal(JSON.stringify(stored).includes(f.input.token), false);
      await request({ url: base, headers: member }, 200, { integrations: [] });
      await request({ url: item, headers: member }, 404, denied);
    });

    await t.test('human integration grants, source permission and administration are separate checks', async () => {
      await setGrants(grants(['read'], [sourceGrant]));
      const readOnly = {
        ...metadata,
        grantsVersion: 2,
        capabilities: { read: true, use: false, manage: false, administer: false },
      };
      await request({ url: base, headers: member }, 200, { integrations: [readOnly] });
      await request({ url: item, headers: member }, 200, {
        ...readOnly,
        repositories: [{ ...f.input.repositories[0], canReadIssues: false }],
      });
      await readIssue(member, f.request(), 404, denied);
      await request(
        { method: 'PUT', url: `${item}/grants`, headers: member, payload: grants(['read', 'use'], [sourceGrant]) },
        404,
        denied,
      );
      await request(
        { method: 'PUT', url: `${item}/owner`, headers: member, payload: { owningTeamId: f.otherTeamId } },
        404,
        denied,
      );
      await request(
        { method: 'PATCH', url: item, headers: member, payload: { name: 'Unauthorized rename' } },
        404,
        denied,
      );
      await request(
        {
          method: 'POST',
          url: `${item}/rotate`,
          headers: member,
          payload: { expectedGeneration: 1, token: 'unauthorized-token' },
        },
        404,
        denied,
      );
      await request({ method: 'DELETE', url: item, headers: member }, 404, denied);
      await setGrants(grants(['read', 'use']));
      const useWithoutSource = await request({ url: item, headers: member }, 200);
      assert.deepEqual(useWithoutSource.capabilities, { read: true, use: true, manage: false, administer: false });
      assert.deepEqual(useWithoutSource.repositories, [{ ...f.input.repositories[0], canReadIssues: false }]);
      await readIssue(member, f.request(), 404, denied);
      assert.equal(f.calls.length, 0);

      await setGrants(grants(['read', 'use'], [sourceGrant]));
      const allowed = await request({ url: item, headers: member }, 200);
      assert.deepEqual(allowed.repositories, [{ ...f.input.repositories[0], canReadIssues: true }]);
      const input = f.request();
      await readIssue(member, input);
      await readIssue(member, input);
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0][0], 'https://api.github.com/repos/tulipfarm/fixture/issues/17');
      assert.equal(f.calls[0][1].headers.Authorization, 'Bearer private-test-token');
      await readIssue(member, { ...f.request(), sourceId: randomUUID() }, 404, denied);
      await setGrants(grants(['read', 'use']));
      await readIssue(member, input, 404, denied);
      assert.equal(f.calls.length, 1);
    });

    await t.test('rotation advances generation and provider failures never disclose secrets', async () => {
      const ownerSource = [{ memberId: f.creator.membershipId, sourceId: f.input.repositories[0].id }];
      await setGrants({ ...grants(['read', 'use']), sourcePersonGrants: ownerSource });
      const rotated = await request(
        {
          method: 'POST',
          url: `${item}/rotate`,
          headers: owner,
          payload: { expectedGeneration: 1, token: 'rotated-http-token' },
        },
        200,
      );
      assert.deepEqual(rotated, {
        ...metadata,
        generation: 2,
        grantsVersion: 6,
        repositories: [{ ...f.input.repositories[0], canReadIssues: true }],
        grants: [{ teamId: f.teamId, permissions: ['read', 'use'] }],
        sourceGrants: [],
        personGrants: [{ memberId: f.creator.membershipId, permissions: ['manage', 'read', 'use'] }],
        sourcePersonGrants: ownerSource,
      });
      await readIssue(admin, f.request(), 404, denied);
      await request(
        {
          method: 'POST',
          url: `${item}/rotate`,
          headers: owner,
          payload: { expectedGeneration: 1, token: 'stale-http-token' },
        },
        409,
        { error: 'conflict' },
      );
      await readIssue(owner);
      assert.equal(f.calls.at(-1)[1].headers.Authorization, 'Bearer rotated-http-token');

      for (const provider of [
        async () => {
          throw new Error('Authorization: Bearer rotated-http-token private-provider-diagnostic');
        },
        async () => new Response('rotated-http-token private-provider-diagnostic', { status: 401 }),
      ]) {
        f.setProvider(provider);
        const input = f.request();
        await readIssue(owner, input, 503, { error: 'provider-retryable' });
        const dispatch = (
          await f.owner.query(
            `SELECT status, generation, result FROM ${f.table('tf_integration_dispatches')} WHERE request_id = $1`,
            [input.requestId],
          )
        ).rows[0];
        assert.deepEqual(dispatch, { status: 'failed', generation: 2, result: null });
      }
      f.setProvider(
        async () =>
          new Response(
            JSON.stringify({
              number: 17,
              title: 'Recovered',
              body: 'rotated-http-token',
              state: 'open',
              credential: 'private-provider-diagnostic',
            }),
          ),
      );
      await readIssue(owner, f.request(), 200, { ...expectedIssue, title: 'Recovered', body: '[redacted]' });
      const stored = JSON.stringify(
        (await f.owner.query(`SELECT row_to_json(c) FROM ${f.table('tf_integrations')} c`)).rows,
      );
      for (const token of [f.input.token, 'rotated-http-token', 'stale-http-token'])
        assert.equal(stored.includes(token), false);
    });

    await t.test('OpenAPI describes versioned operations, input contracts and sanitized errors', async () => {
      const spec = app.swagger();
      const path = '/v1/workspaces/{workspaceId}/integrations';
      const operations = [
        [path, 'get', 'listIntegrationsV1'],
        [path, 'post', 'createIntegrationV1'],
        [`${path}/{integrationId}`, 'get', 'getIntegrationV1'],
        [`${path}/{integrationId}`, 'patch', 'updateIntegrationV1'],
        [`${path}/{integrationId}`, 'delete', 'deleteIntegrationV1'],
        [`${path}/{integrationId}/rotate`, 'post', 'rotateIntegrationV1'],
        [`${path}/{integrationId}/grants`, 'put', 'setIntegrationGrantsV1'],
        [`${path}/{integrationId}/owner`, 'put', 'transferIntegrationV1'],
        [`${path}/read-issue`, 'post', 'readIntegrationIssueV1'],
      ];
      for (const [url, method, operationId] of operations) {
        const operation = spec.paths[url]?.[method];
        assert.equal(operation?.operationId, operationId);
        assert.deepEqual(operation.tags, ['Integrations']);
        for (const status of [200, 400, 401, 403, 404, 409, 500, 502, 503]) {
          assert.ok(operation.responses[status], `${operationId} documents ${status}`);
        }
        const workspaceParameter = operation.parameters.find(parameter => parameter.name === 'workspaceId');
        assert.equal(workspaceParameter.in, 'path');
        assert.equal(workspaceParameter.required, true);
        assert.equal(workspaceParameter.schema.type, 'string');
        assert.equal(workspaceParameter.schema.format, 'uuid');
        const response = JSON.stringify(operation.responses[200]);
        assert.equal(/ciphertext|credential|"token"/.test(response), false);
      }
      const create = spec.paths[path].post.requestBody.content['application/json'].schema;
      assert.deepEqual(create.required, ['id', 'name', 'owningTeamId', 'token', 'repositories']);
      assert.equal(create.additionalProperties, false);
      assert.equal(create.properties.token.type, 'string');
      const providerError = spec.paths[`${path}/read-issue`].post.responses[502].content['application/json'].schema;
      assert.deepEqual(providerError, {
        type: 'object',
        properties: { error: { type: 'string' } },
        required: ['error'],
        additionalProperties: false,
      });
    });

    await t.test('disabled and deleted integrations cannot dispatch and revoked sessions stop working', async () => {
      const disabled = await request({ method: 'PATCH', url: item, headers: owner, payload: { enabled: false } }, 200);
      assert.equal(disabled.enabled, false);
      assert.equal(disabled.capabilities.use, false);
      await readIssue(owner, f.request(), 404, denied);
      await request({ method: 'DELETE', url: item, headers: owner }, 200, { removed: true });
      await request({ url: item, headers: owner }, 404, denied);
      await request({ url: base, headers: owner }, 200, { integrations: [] });
      assert.deepEqual(
        (
          await f.owner.query(`SELECT credential, enabled FROM ${f.table('tf_integrations')} WHERE id = $1`, [
            f.input.id,
          ])
        ).rows,
        [{ credential: null, enabled: false }],
      );
      sessions.delete(owner.cookie);
      await request({ url: base, headers: owner }, 401, { error: 'sign-in-required' });
    });
  } finally {
    try {
      await app.close();
    } finally {
      await f.close();
    }
  }
});
