import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { mcpFixture } from '../../../packages/workspace-mcp/test/fixture.mjs';
import { createOAuthOperations, MCP_OAUTH_CLIENT_ID, MCP_OAUTH_REDIRECT_URI } from '@tulipfarm/workspace-mcp-transport';
import { createWorkspaceMcpOAuth } from '../src/workspace-mcp-oauth.ts';
import { mcpProtocolFixture } from './workspace-mcp-protocol-fixture.mjs';
import { workspaceMcpDiscovery } from '../src/workspace-mcp-discovery.ts';

test('OAuth composition consumes restricted PostgreSQL session state once before code exchange', async t => {
  const f = await mcpFixture();
  const remote = await mcpProtocolFixture(t);
  const service = f.make({ protocol: remote.protocol });
  const discovery = workspaceMcpDiscovery(f.runtime, service);
  const member = f.members[0];
  const session = 'authenticated-login-session-1234';
  const otherSession = 'different-authenticated-session';
  const endpoint = 'https://mcp.example.com/tools';
  const issuer = 'https://identity.example.com';
  const exchanges = [];
  let release;
  let entered;
  let gated = false;
  const network = createOAuthOperations({
    fetcher: async (url, init) => {
      const target = String(url);
      if (target === endpoint) return new Response('', { status: 401 });
      if (target.includes('oauth-protected-resource'))
        return Response.json({ resource: endpoint, authorization_servers: [issuer] });
      if (target.includes('oauth-authorization-server'))
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          code_challenge_methods_supported: ['S256'],
          response_types_supported: ['code'],
          token_endpoint_auth_methods_supported: ['none'],
          client_id_metadata_document_supported: true,
          authorization_response_iss_parameter_supported: true,
        });
      assert.equal(target, `${issuer}/token`);
      const body = new URLSearchParams(init.body);
      if (body.get('grant_type') === 'authorization_code')
        assert.equal(body.get('redirect_uri'), MCP_OAUTH_REDIRECT_URI);
      assert.equal(body.get('table'), endpoint);
      assert.equal(body.get('client_id'), MCP_OAUTH_CLIENT_ID);
      if (body.get('grant_type') === 'authorization_code') assert.ok(body.get('code_verifier').length >= 43);
      exchanges.push(body);
      if (gated) {
        entered();
        await new Promise(resolve => {
          release = resolve;
        });
      }
      return Response.json({
        token_type: 'Bearer',
        access_token: 'synthetic-oauth-access',
        refresh_token: 'synthetic-oauth-refresh',
        expires_in: 3600,
      });
    },
  });
  const oauth = createWorkspaceMcpOAuth(service, network, discovery.discover);
  const begin = async () => {
    const integration = await f.service.create(f.one.id, member, {
      requestId: randomUUID(),
      name: 'OAuth integration',
      ownership: 'personal',
      endpoint,
      credential: { kind: 'none' },
    });
    const result = await oauth.begin(f.one.id, member.userId, session, integration.id, { kind: 'oauth' });
    assert.equal(result.kind, 'oauth');
    const url = new URL(result.authorizationUrl);
    assert.equal(url.searchParams.get('redirect_uri'), MCP_OAUTH_REDIRECT_URI);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    return { integration, state: url.searchParams.get('state') };
  };
  try {
    await t.test(
      'wrong user and same-user different login cannot exchange or burn the initiating session state',
      async () => {
        const started = await begin();
        const callback = { state: started.state, code: 'private-code', iss: issuer };
        await assert.rejects(oauth.complete(member.userId, otherSession, callback));
        await assert.rejects(oauth.complete(f.admin.userId, session, callback));
        assert.equal(exchanges.length, 0);
        assert.deepEqual(await oauth.complete(member.userId, session, callback), {
          workspaceId: f.one.id,
          integrationId: started.integration.id,
        });
        assert.equal(exchanges.length, 1);
        assert.deepEqual(
          remote.requests.map(request => request.method),
          ['initialize', 'notifications/initialized', 'tools/list'],
        );
        assert.ok(remote.requests.every(request => request.headers.authorization === 'Bearer synthetic-oauth-access'));
        assert.equal(
          await discovery.validated(
            f.one.id,
            member.userId,
            await service.status(f.one.id, member, started.integration.id),
          ),
          true,
        );
        assert.equal((await service.tools(f.one.id, member, started.integration.id)).length, 2);
        await assert.rejects(oauth.complete(member.userId, session, callback));
        assert.equal(exchanges.length, 1);
        const rows = await f.db.platform.query(`SELECT credential FROM ${f.table('integrations')} WHERE id=$1`, [
          started.integration.id,
        ]);
        assert.ok(rows.rows[0].credential.ciphertext);
        assert.equal(JSON.stringify(rows.rows).includes('synthetic-oauth'), false);
      },
    );
    await t.test('failed callback discovery preserves exchanged tokens for explicit discovery recovery', async () => {
      const started = await begin();
      const callback = { state: started.state, code: 'recoverable-oauth-code', iss: issuer };
      remote.setFailure(true);
      await assert.rejects(
        oauth.complete(member.userId, session, callback),
        error => error.code === 'discovery-failed',
      );
      const saved = await service.status(f.one.id, member, started.integration.id);
      assert.equal(saved.lifecycle, 'active');
      assert.equal(saved.authMethod, 'oauth');
      assert.equal(await discovery.validated(f.one.id, member.userId, saved), false);
      const credential = (
        await f.db.platform.query(`SELECT credential FROM ${f.table('integrations')} WHERE id=$1`, [saved.id])
      ).rows[0].credential;
      assert.ok(credential.ciphertext);
      await assert.rejects(oauth.complete(member.userId, session, callback));
      assert.equal(exchanges.filter(body => body.get('code') === callback.code).length, 1);
      remote.setFailure(false);
      const input = { requestId: randomUUID(), expectedVersion: saved.version };
      await discovery.discover(f.one.id, member.userId, saved.id, input);
      const recovered = await service.status(f.one.id, member, saved.id);
      assert.equal(await discovery.validated(f.one.id, member.userId, recovered), true);
      assert.equal(recovered.secretVersion, saved.secretVersion);
      assert.equal(recovered.authorizationEpoch, saved.authorizationEpoch);
      assert.equal(recovered.version, saved.version + 1);
      const count = remote.requests.length;
      await discovery.discover(f.one.id, member.userId, saved.id, input);
      assert.equal(remote.requests.length, count);
      assert.deepEqual(
        (await f.db.platform.query(`SELECT credential FROM ${f.table('integrations')} WHERE id=$1`, [saved.id])).rows[0]
          .credential,
        credential,
      );
    });
    await t.test('denial consumes state and never forwards provider diagnostics', async () => {
      const started = await begin();
      const before = exchanges.length;
      await assert.rejects(
        oauth.complete(member.userId, session, {
          state: started.state,
          error: 'access_denied',
          error_description: 'private-diagnostic',
        }),
        error => error.code === 'mcp-authorization-denied' && !error.message.includes('private-diagnostic'),
      );
      await assert.rejects(
        oauth.complete(member.userId, session, { state: started.state, code: 'private-code', iss: issuer }),
      );
      assert.equal(exchanges.length, before);
    });
    await t.test('wrong callback issuer fails before token exchange and consumes the attempt', async () => {
      const started = await begin();
      const before = exchanges.length;
      await assert.rejects(
        oauth.complete(member.userId, session, {
          state: started.state,
          code: 'private-code',
          iss: 'https://other.example.com',
        }),
      );
      assert.equal(exchanges.length, before);
      await assert.rejects(
        oauth.complete(member.userId, session, { state: started.state, code: 'private-code', iss: issuer }),
      );
    });
    await t.test('concurrent callbacks exchange once even before the first token response', async () => {
      const started = await begin();
      const ready = new Promise(resolve => {
        entered = resolve;
      });
      gated = true;
      const callback = { state: started.state, code: 'concurrent-private-code', iss: issuer };
      const pending = oauth.complete(member.userId, session, callback);
      await ready;
      try {
        await assert.rejects(oauth.complete(member.userId, session, callback));
      } finally {
        gated = false;
        release();
      }
      assert.equal((await pending).integrationId, started.integration.id);
      assert.equal(exchanges.filter(body => body.get('code') === 'concurrent-private-code').length, 1);
    });
    await t.test('due credential refresh uses one durable claim and preserves authority epoch', async () => {
      const started = await begin();
      await oauth.complete(member.userId, session, { state: started.state, code: 'refresh-setup-code', iss: issuer });
      const before = await f.service.status(f.one.id, member.userId, started.integration.id);
      await f.db.platform.query(
        `UPDATE ${f.table('integrations')} SET credential_expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1`,
        [started.integration.id],
      );
      const ready = new Promise(resolve => {
        entered = resolve;
      });
      gated = true;
      const pending = oauth.refresh(f.one.id, member.userId, started.integration.id);
      await ready;
      try {
        await assert.rejects(oauth.refresh(f.one.id, member.userId, started.integration.id));
      } finally {
        gated = false;
        release();
      }
      const after = await pending;
      assert.equal(after.authorizationEpoch, before.authorizationEpoch);
      assert.equal(after.secretVersion, before.secretVersion + 1);
      assert.equal(after.refreshDue, false);
      assert.equal(exchanges.filter(body => body.get('grant_type') === 'refresh_token').length, 1);
    });
    await t.test(
      'explicit Basic and POST clients preserve their registered method at one issuer through refresh',
      async () => {
        for (const authMethod of ['client_secret_basic', 'client_secret_post']) {
          const requests = [];
          const client = {
            clientId: `registered-${authMethod}`,
            authMethod,
            clientSecret: 'synthetic-registered-secret',
          };
          const registeredNetwork = createOAuthOperations({
            fetcher: async (url, init) => {
              const target = String(url);
              if (target === endpoint) return new Response('', { status: 401 });
              if (target.includes('oauth-protected-resource'))
                return Response.json({ resource: endpoint, authorization_servers: [issuer] });
              if (target.includes('oauth-authorization-server'))
                return Response.json({
                  issuer,
                  authorization_endpoint: `${issuer}/authorize`,
                  token_endpoint: `${issuer}/token`,
                  code_challenge_methods_supported: ['S256'],
                  response_types_supported: ['code'],
                  token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
                });
              assert.equal(target, `${issuer}/token`);
              const body = new URLSearchParams(init.body);
              const authorization = new Headers(init.headers).get('authorization');
              if (authMethod === 'client_secret_basic') {
                assert.equal(
                  authorization,
                  `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`,
                );
                assert.equal(body.has('client_secret'), false);
              } else {
                assert.equal(authorization, null);
                assert.equal(body.get('client_id'), client.clientId);
                assert.equal(body.get('client_secret'), client.clientSecret);
              }
              requests.push(body.get('grant_type'));
              return Response.json({
                token_type: 'Bearer',
                access_token: 'registered-access-token',
                refresh_token: 'registered-refresh-token',
                expires_in: 3600,
              });
            },
          });
          const registered = createWorkspaceMcpOAuth(f.service, registeredNetwork);
          const integration = await f.service.create(f.one.id, member, {
            requestId: randomUUID(),
            name: 'Registered client',
            ownership: 'personal',
            endpoint,
            credential: { kind: 'none' },
          });
          const started = await registered.begin(f.one.id, member.userId, session, integration.id, {
            kind: 'oauth',
            client,
          });
          assert.equal(started.kind, 'oauth');
          await registered.complete(member.userId, session, {
            state: new URL(started.authorizationUrl).searchParams.get('state'),
            code: 'registered-private-code',
          });
          await f.db.platform.query(
            `UPDATE ${f.table('integrations')} SET credential_expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1`,
            [integration.id],
          );
          await registered.refresh(f.one.id, member.userId, integration.id);
          assert.deepEqual(requests, ['authorization_code', 'refresh_token']);
        }
      },
    );
    await t.test('persisted callback URI mismatch consumes state without exchanging a code', async () => {
      const integration = await f.service.create(f.one.id, member, {
        requestId: randomUUID(),
        name: 'Callback binding',
        ownership: 'personal',
        endpoint,
        credential: { kind: 'none' },
      });
      const binding = await network.discoverOAuth({ endpoint });
      const client = await network.registerOAuthClient({ binding });
      const authorization = network.createOAuthAuthorization({ binding, client, state: 's'.repeat(43) });
      const attempt = await f.service.beginOAuth(f.one.id, member, integration.id, {
        sessionId: session,
        material: {
          binding,
          client,
          verifier: authorization.verifier,
          redirectUri: `${MCP_OAUTH_REDIRECT_URI}/other`,
          scopes: authorization.scopes,
        },
      });
      const before = exchanges.length;
      const callback = { state: `${f.one.id}_${attempt.state}`, code: 'callback-mismatch-code', iss: issuer };
      await assert.rejects(oauth.complete(member.userId, session, callback));
      await assert.rejects(oauth.complete(member.userId, session, callback));
      assert.equal(exchanges.length, before);
      assert.equal((await f.service.status(f.one.id, member, integration.id)).lifecycle, 'reconnect-required');
    });
  } finally {
    await f.close();
  }
});
