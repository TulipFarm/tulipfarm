import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { apiMcpFixture } from './workspace-mcp-fixture.mjs';
import { createRegistryCatalog } from '@tulipfarm/workspace-mcp-transport';
import { createWorkspaceMcpApi } from '../src/workspace-mcp-service.ts';
import { registerWorkspaceMcp } from '../src/workspace-mcp.ts';
import { workspaceMcpCatalog } from '../src/workspace-mcp-catalog.ts';
import { workspaceMcpPermissions } from '../src/workspace-mcp-permissions.ts';
import { authConfig } from '../src/auth.ts';
import { registerConversations } from '../src/conversations.ts';
import { createConversations } from '@tulipfarm/conversations';
import { mcpProtocolFixture } from './workspace-mcp-protocol-fixture.mjs';
import { mcpDiscoveryRequestId } from '../src/workspace-mcp-discovery.ts';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

test('workspace MCP HTTP uses real restricted domain storage and never dispatches tools', async t => {
  const remote = await mcpProtocolFixture(t);
  const f = await apiMcpFixture({ protocol: remote.protocol });
  const app = Fastify();
  const member = f.members[0];
  const origin = authConfig().webOrigin;
  const headers = { origin, cookie: 'member' };
  const sessions = new Map([
    ['member', member.userId],
    ['admin', f.admin.userId],
    ['other', f.members[1].userId],
  ]);
  const auth = {
    api: {
      getSession: async ({ headers }) => {
        const id = sessions.get(headers.get('cookie'));
        return id ? { user: { id }, session: { id: `authenticated-session-${id}` } } : null;
      },
    },
  };
  const catalog = workspaceMcpCatalog(
    createRegistryCatalog({
      fetcher: async () => {
        throw new Error('registry-down-private-diagnostic');
      },
    }),
  );
  const permissions = workspaceMcpPermissions(f.runtime, f.service);
  const service = createWorkspaceMcpApi({ ...f.options, service: f.service, catalog, permissions });
  await app.register(swagger, { openapi: { openapi: '3.0.3', info: { title: 'MCP', version: '1' } } });
  await app.register(async routes => registerWorkspaceMcp(routes, auth, service), { prefix: '/v1' });
  await app.register(async routes => registerConversations(routes, { auth, service: createConversations(f.runtime) }), {
    prefix: '/v1',
  });
  const base = `/v1/workspaces/${f.one.id}/workspace-mcp`;
  async function request(options, status) {
    const response = await app.inject({ headers, ...options });
    assert.equal(response.statusCode, status, response.body);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    return response.json();
  }
  let integration;
  try {
    await t.test(
      'every MCP route authenticates before validation and unsafe methods require the trusted origin',
      async () => {
        await app.ready();
        const substitutions = {
          workspaceId: f.one.id,
          integrationId: randomUUID(),
          actionId: randomUUID(),
          originId: randomUUID(),
          agentId: randomUUID(),
          kind: 'chat',
        };
        for (const [path, methods] of Object.entries(app.swagger().paths)) {
          if (!path.includes('workspace-mcp')) continue;
          const url = path.replace(/\{([^}]+)\}/g, (_match, name) => substitutions[name]);
          for (const method of Object.keys(methods)) {
            if (!['get', 'post', 'put', 'delete'].includes(method)) continue;
            const response = await app.inject({ method: method.toUpperCase(), url, headers: { origin } });
            assert.equal(response.statusCode, 401, `${method} ${url}: ${response.body}`);
            assert.equal(response.headers['cache-control'], 'no-store');
            if (method !== 'get') {
              const denied = await app.inject({
                method: method.toUpperCase(),
                url,
                headers: { origin: 'https://foreign.example', cookie: 'member' },
              });
              assert.equal(denied.statusCode, 403, `${method} ${url}: ${denied.body}`);
            }
          }
        }
        assert.equal(f.calls.length, 0);
      },
    );
    await t.test('catalog outage does not block manual setup and integration creation is durable', async () => {
      await catalog.refresh();
      const listing = await request({ url: `${base}/catalog?search=missing` }, 200);
      assert.equal(listing.stale, true);
      assert.deepEqual(listing.entries, []);
      const payload = {
        requestId: randomUUID(),
        name: 'Private reports',
        ownership: 'personal',
        endpoint: 'https://mcp.example.com/tools',
        auth: { kind: 'bearer', token: 'synthetic-private-mcp-secret' },
      };
      const created = await request({ method: 'POST', url: `${base}/integrations`, payload }, 200);
      integration = created.integration;
      assert.equal(created.kind, 'saved');
      assert.equal(integration.status, 'review-required');
      assert.deepEqual(
        remote.requests.map(request => request.method),
        ['initialize', 'notifications/initialized', 'tools/list'],
      );
      assert.ok(remote.requests.every(request => request.headers.authorization === `Bearer ${payload.auth.token}`));
      assert.equal(integration.canManage, true);
      assert.equal(integration.authMethod, 'bearer');
      assert.equal(JSON.stringify(created).includes(payload.auth.token), false);
      const repeated = await request({ method: 'POST', url: `${base}/integrations`, payload }, 200);
      assert.equal(repeated.integration.id, integration.id);
      assert.equal(repeated.integration.version, integration.version);
      assert.equal(remote.requests.length, 3);
      const commands = (
        await f.db.platform.query(
          `SELECT request_id,kind FROM ${f.table('commands')} WHERE membership_id=$1 ORDER BY kind`,
          [member.membershipId],
        )
      ).rows;
      assert.deepEqual(commands, [
        { request_id: mcpDiscoveryRequestId(mcpDiscoveryRequestId(payload.requestId)), kind: 'api-discovery' },
        { request_id: payload.requestId, kind: 'create' },
        { request_id: mcpDiscoveryRequestId(payload.requestId), kind: 'discover' },
      ]);
      await request(
        { method: 'POST', url: `${base}/integrations`, payload: { ...payload, name: 'Changed command' } },
        409,
      );
      const stored = (
        await f.db.platform.query(`SELECT credential FROM ${f.table('integrations')} WHERE id=$1`, [integration.id])
      ).rows[0];
      assert.ok(stored.credential.ciphertext);
      assert.equal(JSON.stringify(stored).includes(payload.auth.token), false);
    });
    await t.test(
      'failed setup keeps one encrypted credential and retries discovery with the same command',
      async () => {
        const payload = {
          requestId: randomUUID(),
          name: 'Recoverable setup',
          ownership: 'personal',
          endpoint: 'https://mcp.example.com/recovery',
          auth: { kind: 'headers', headers: [{ name: 'X-Api-Key', value: 'recoverable-private-secret' }] },
        };
        remote.setFailure(true);
        assert.deepEqual(await request({ method: 'POST', url: `${base}/integrations`, payload }, 503), {
          error: 'mcp-discovery-failed',
        });
        const saved = (await request({ url: `${base}/integrations` }, 200)).integrations.find(
          item => item.name === payload.name,
        );
        assert.equal(saved.status, 'setup');
        const before = (
          await f.db.platform.query(
            `SELECT credential,secret_version,authorization_epoch,version FROM ${f.table('integrations')} WHERE id=$1`,
            [saved.id],
          )
        ).rows[0];
        assert.ok(before.credential.ciphertext);
        assert.deepEqual((await request({ url: `${base}/integrations/${saved.id}` }, 200)).tools, []);
        await request({ method: 'POST', url: `${base}/integrations`, payload }, 503);
        remote.setFailure(false);
        const recovered = await request({ method: 'POST', url: `${base}/integrations`, payload }, 200);
        assert.equal(recovered.integration.id, saved.id);
        assert.equal(recovered.integration.status, 'review-required');
        const after = (
          await f.db.platform.query(
            `SELECT credential,secret_version,authorization_epoch,version FROM ${f.table('integrations')} WHERE id=$1`,
            [saved.id],
          )
        ).rows[0];
        assert.deepEqual(after, { ...before, version: before.version + 1 });
        const count = remote.requests.length;
        assert.deepEqual(await request({ method: 'POST', url: `${base}/integrations`, payload }, 200), recovered);
        assert.equal(remote.requests.length, count);
        assert.equal(
          (await f.db.platform.query(`SELECT id FROM ${f.table('integrations')} WHERE name=$1`, [payload.name]))
            .rowCount,
          1,
        );
        const replacement = {
          ...payload,
          requestId: randomUUID(),
          expectedVersion: recovered.integration.version,
          auth: { kind: 'bearer', token: 'replacement-private-secret' },
        };
        remote.setFailure(true);
        await request({ method: 'POST', url: `${base}/integrations/${saved.id}/setup`, payload: replacement }, 503);
        const replaced = await f.service.status(f.one.id, member, saved.id);
        assert.equal(replaced.secretVersion, after.secret_version + 1);
        assert.equal((await request({ url: `${base}/integrations/${saved.id}` }, 200)).integration.status, 'setup');
        remote.setFailure(false);
        const retried = await request(
          { method: 'POST', url: `${base}/integrations/${saved.id}/setup`, payload: replacement },
          200,
        );
        assert.equal(retried.integration.status, 'review-required');
        assert.equal((await f.service.status(f.one.id, member, saved.id)).secretVersion, replaced.secretVersion);
        assert.equal(retried.integration.authorizationEpoch, replaced.authorizationEpoch);
        await request(
          {
            method: 'POST',
            url: `${base}/integrations/${saved.id}/setup`,
            payload: { ...replacement, requestId: randomUUID() },
          },
          409,
        );
      },
    );
    await t.test('malformed discovery stays unverified and a validated empty catalog is reviewable', async () => {
      const payload = {
        requestId: randomUUID(),
        name: 'Empty server',
        ownership: 'personal',
        endpoint: 'https://mcp.example.com/empty',
        auth: { kind: 'none' },
      };
      remote.setTools([{ name: 'invalid', inputSchema: 'not-an-object' }]);
      await request({ method: 'POST', url: `${base}/integrations`, payload }, 503);
      remote.setTools([]);
      const created = await request({ method: 'POST', url: `${base}/integrations`, payload }, 200);
      assert.equal(created.integration.status, 'review-required');
      assert.deepEqual((await request({ url: `${base}/integrations/${created.integration.id}` }, 200)).tools, []);
      remote.resetTools();
    });
    await t.test(
      'the full review payload for a 200-tool catalog saves one enabled tool and rejects 101 enabled',
      async () => {
        remote.setTools(
          Array.from({ length: 200 }, (_, index) => ({
            name: `tool-${String(index).padStart(3, '0')}`,
            description: 'Read a record',
            inputSchema: { type: 'object', additionalProperties: false },
          })),
        );
        const created = await request(
          {
            method: 'POST',
            url: `${base}/integrations`,
            payload: {
              requestId: randomUUID(),
              name: 'Large server',
              ownership: 'personal',
              endpoint: 'https://mcp.example.com/large',
              auth: { kind: 'none' },
            },
          },
          200,
        );
        remote.resetTools();
        const item = `${base}/integrations/${created.integration.id}`;
        const detail = await request({ url: item }, 200);
        assert.equal(detail.tools.length, 200);
        const payload = enabled => ({
          requestId: randomUUID(),
          expectedVersion: detail.integration.version,
          tools: detail.tools.map((tool, index) => ({
            name: tool.name,
            revision: tool.revision,
            enabled: index < enabled,
            standingException: false,
          })),
        });
        assert.deepEqual(await request({ method: 'PUT', url: `${item}/tools`, payload: payload(101) }, 409), {
          error: 'mcp-limit',
        });
        const reviewed = await request({ method: 'PUT', url: `${item}/tools`, payload: payload(1) }, 200);
        assert.deepEqual(
          reviewed.tools.filter(tool => tool.enabled).map(tool => tool.name),
          ['tool-000'],
        );
      },
    );
    await t.test('another member and an administrator cannot read or change personal metadata', async () => {
      for (const cookie of ['other', 'admin']) {
        const deniedHeaders = { origin, cookie };
        assert.deepEqual(
          (await request({ url: `${base}/integrations`, headers: deniedHeaders }, 200)).integrations,
          [],
        );
        await request({ url: `${base}/integrations/${integration.id}`, headers: deniedHeaders }, 404);
        await request(
          {
            method: 'POST',
            url: `${base}/integrations/${integration.id}/lifecycle`,
            headers: deniedHeaders,
            payload: { requestId: randomUUID(), expectedVersion: integration.version, operation: 'disconnect' },
          },
          404,
        );
      }
    });
    await t.test('discovery starts disabled, exact review enables tools, and stale mutation conflicts', async () => {
      const item = `${base}/integrations/${integration.id}`;
      const discovered = await request(
        {
          method: 'POST',
          url: `${item}/discover`,
          payload: { requestId: randomUUID(), expectedVersion: integration.version },
        },
        200,
      );
      assert.ok(discovered.tools.length);
      assert.ok(discovered.tools.every(tool => !tool.enabled && !tool.standingException));
      const payload = {
        requestId: randomUUID(),
        expectedVersion: discovered.integration.version,
        tools: discovered.tools.map(tool => ({
          name: tool.name,
          revision: tool.revision,
          enabled: true,
          standingException: true,
        })),
      };
      const reviewed = await request({ method: 'PUT', url: `${item}/tools`, payload }, 200);
      assert.ok(reviewed.tools.every(tool => tool.enabled && tool.standingException));
      assert.equal(reviewed.integration.status, 'ready');
      await request({ method: 'PUT', url: `${item}/tools`, payload: { ...payload, requestId: randomUUID() } }, 409);
      integration = reviewed.integration;
    });
    await t.test('exact decisions persist through confirmation login without API dispatch', async () => {
      const proposed = await f.propose(integration);
      const item = `${base}/actions/${proposed.id}`;
      const view = await request({ url: item }, 200);
      assert.equal(view.visibility, 'full');
      assert.equal(view.exact.outboundConsentRequired, true);
      assert.deepEqual(view.exact.arguments, { text: 'private input' });
      await request(
        {
          method: 'POST',
          url: `${item}/decision`,
          payload: { requestId: randomUUID(), digest: 'f'.repeat(64), decision: 'approve' },
        },
        409,
      );
      await request(
        {
          method: 'POST',
          url: `${item}/decision`,
          headers: { origin, cookie: 'admin' },
          payload: { requestId: randomUUID(), digest: view.digest, decision: 'approve' },
        },
        404,
      );
      const decision = await request(
        {
          method: 'POST',
          url: `${item}/decision`,
          payload: { requestId: randomUUID(), digest: view.digest, decision: 'approve' },
        },
        200,
      );
      assert.equal(decision.status, 'ready');
      assert.equal(f.calls.length, 0);
      const execute = await app.inject({ method: 'POST', url: `${item}/execute`, headers });
      assert.equal(execute.statusCode, 404);
      const stored = (
        await f.db.platform.query(`SELECT decision,digest FROM ${f.table('decisions')} WHERE action_id=$1`, [view.id])
      ).rows[0];
      assert.deepEqual(stored, { decision: 'approve', digest: view.digest });
      await assert.rejects(
        f.runtime.transaction(f.one.id, commonCompatibility, tx =>
          tx.client.query(
            `INSERT INTO ${f.table('decisions')} (action_id,membership_id,digest,decision) VALUES ($1,$2,$3,'reject')`,
            [view.id, member.membershipId, view.digest],
          ),
        ),
        error => error.code === '42501',
      );
    });
    await t.test('private selection works before the first turn and rejects another requester', async () => {
      const chatId = randomUUID();
      const chatPath = `/v1/workspaces/${f.one.id}/conversations/${chatId}`;
      const path = `${base}/selections/chat/${chatId}`;
      await request({ url: path }, 404);
      assert.equal(
        (await f.db.platform.query(`SELECT id FROM ${f.table('tf_conversations')} WHERE id=$1`, [chatId])).rowCount,
        0,
      );
      const reservation = { requestId: randomUUID() };
      assert.deepEqual(await request({ method: 'POST', url: `${path}/reserve`, payload: reservation }, 200), {
        id: chatId,
      });
      assert.deepEqual(await request({ method: 'POST', url: `${path}/reserve`, payload: reservation }, 200), {
        id: chatId,
      });
      await request(
        {
          method: 'POST',
          url: `${path}/reserve`,
          headers: { origin, cookie: 'other' },
          payload: { requestId: randomUUID() },
        },
        404,
      );
      const empty = await request({ url: path }, 200);
      assert.equal(empty.version, 0);
      assert.deepEqual(empty.bindings, []);
      assert.equal(empty.choices.find(choice => choice.integration.id === integration.id).integration.status, 'ready');
      const payload = {
        requestId: randomUUID(),
        expectedVersion: 0,
        bindings: [{ integrationId: integration.id, slotId: null }],
      };
      const selected = await request({ method: 'PUT', url: path, payload }, 200);
      assert.equal(selected.version, 1);
      assert.deepEqual(selected.bindings, payload.bindings);
      assert.deepEqual((await request({ method: 'PUT', url: path, payload }, 200)).bindings, payload.bindings);
      await request({ url: path, headers: { origin, cookie: 'admin' } }, 404);
      await request({ method: 'PUT', url: path, payload: { ...payload, requestId: randomUUID() } }, 409);
      const sent = await app.inject({
        method: 'PUT',
        url: `${chatPath}/messages/${randomUUID()}`,
        headers,
        payload: { commandId: randomUUID(), parts: [{ kind: 'text', text: 'Use my selected integration.' }] },
      });
      assert.equal(sent.statusCode, 200, sent.body);
      assert.deepEqual((await request({ url: path }, 200)).bindings, payload.bindings);
    });
    await t.test(
      'actual web clients reserve once, select, and send the first message through real API routes',
      async () => {
        const requireWeb = createRequire(new URL('../../web/package.json', import.meta.url));
        const { createServer } = await import(requireWeb.resolve('vite'));
        const vite = await createServer({
          root: fileURLToPath(new URL('../../web', import.meta.url)),
          server: { middlewareMode: true },
          logLevel: 'error',
        });
        const originalFetch = globalThis.fetch;
        const requests = [];
        const windowBefore = globalThis.window;
        globalThis.window = new EventTarget();
        try {
          const { apiOrigin } = await vite.ssrLoadModule('/src/lib/auth.ts');
          globalThis.fetch = async (url, init) => {
            if (!String(url).startsWith(`${apiOrigin}/v1/`)) return originalFetch(url, init);
            const parsed = new URL(url);
            requests.push({ method: init.method, path: parsed.pathname, body: init.body && JSON.parse(init.body) });
            const response = await app.inject({
              method: init.method,
              url: parsed.pathname + parsed.search,
              headers: { ...headers, ...Object.fromEntries(new Headers(init.headers)) },
              ...(init.body ? { payload: init.body } : {}),
            });
            return new Response(response.body, { status: response.statusCode, headers: response.headers });
          };
          const { conversationApi, draftConversationApi } = await vite.ssrLoadModule(
            '/src/features/chat/conversation-api.ts',
          );
          const { mcpApi } = await vite.ssrLoadModule('/src/features/workspace-mcp/api.ts');
          const chatId = randomUUID();
          const chat = draftConversationApi(
            conversationApi(f.one.id, status => assert.fail(`Unexpected access loss ${status}`)),
            chatId,
          );
          const api = mcpApi(f.one.id);
          const subject = { kind: 'chat', id: chatId };
          const signal = AbortSignal.timeout(30000);
          const [selection] = await Promise.all([
            api.selection(subject, signal, chat.prepareChat),
            api.selection(subject, signal, chat.prepareChat),
          ]);
          const bindings = [{ integrationId: integration.id, slotId: null }];
          await api.saveSelection(subject, { requestId: randomUUID(), expectedVersion: selection.version, bindings });
          const message = {
            kind: 'send',
            chatId,
            commandId: randomUUID(),
            messageId: randomUUID(),
            model: 'anthropic-claude-sonnet-4-6',
            parts: [{ kind: 'text', text: 'Use my selected integration.' }],
          };
          const sent = await chat.command(message, signal);
          assert.equal(sent.messageId, message.messageId);
          assert.equal(sent.sequence, 1);
          assert.deepEqual((await api.selection(subject, signal, chat.prepareChat)).bindings, bindings);
          assert.equal(requests.filter(item => item.path.endsWith('/reserve')).length, 1);
          assert.equal(
            requests.filter(item => item.method === 'PUT' && item.path.endsWith(`/conversations/${chatId}`)).length,
            0,
          );
          assert.equal(requests[0].method, 'POST');
          assert.ok(requests[0].path.endsWith('/reserve'));
          const stored = (
            await f.db.platform.query(
              `SELECT command_id,operation FROM ${f.table('tf_conversation_commands')} WHERE conversation_id=$1 ORDER BY operation`,
              [chatId],
            )
          ).rows;
          assert.deepEqual(stored, [
            { command_id: requests[0].body.requestId, operation: 'create' },
            { command_id: message.commandId, operation: 'send' },
          ]);
          assert.equal(
            (await f.db.platform.query(`SELECT id FROM ${f.table('tf_conversations')} WHERE id=$1`, [chatId])).rowCount,
            1,
          );
        } finally {
          globalThis.fetch = originalFetch;
          globalThis.window = windowBefore;
          await vite.close();
        }
      },
    );
    await t.test(
      'shared creator manages explicit grants and never sees or recovers another requester action',
      async () => {
        const creator = { origin, cookie: 'admin' };
        const created = await request(
          {
            method: 'POST',
            url: `${base}/integrations`,
            headers: creator,
            payload: {
              requestId: randomUUID(),
              name: 'Shared reports',
              ownership: 'shared',
              endpoint: 'https://mcp.example.com/shared',
              auth: { kind: 'none' },
            },
          },
          200,
        );
        assert.equal(created.integration.canManage, true);
        assert.equal(created.integration.canUse, true);
        const shared = created.integration;
        const granted = await request(
          {
            method: 'PUT',
            url: `${base}/integrations/${shared.id}/grants`,
            headers: creator,
            payload: {
              requestId: randomUUID(),
              expectedVersion: shared.version,
              grants: [{ kind: 'member', id: f.members[1].membershipId }],
            },
          },
          200,
        );
        assert.equal(granted.integration.canUse, false);
        assert.equal(granted.integration.canManage, true);
        await request({ url: `${base}/integrations/${shared.id}`, headers: { origin, cookie: 'member' } }, 404);
        const discovered = await request(
          {
            method: 'POST',
            url: `${base}/integrations/${shared.id}/discover`,
            headers: creator,
            payload: { requestId: randomUUID(), expectedVersion: granted.integration.version },
          },
          200,
        );
        await request(
          {
            method: 'PUT',
            url: `${base}/integrations/${shared.id}/tools`,
            headers: creator,
            payload: {
              requestId: randomUUID(),
              expectedVersion: discovered.integration.version,
              tools: discovered.tools.map(tool => ({
                name: tool.name,
                revision: tool.revision,
                enabled: true,
                standingException: false,
              })),
            },
          },
          200,
        );
        const proposed = await f.propose(shared, f.members[1]);
        await f.service.decide(f.one.id, f.members[1], proposed.id, { digest: proposed.digest, decision: 'approve' });
        await f.db.platform.query(
          `INSERT INTO ${f.table('claims')} (action_id,integration_id,token,deadline) VALUES ($1,$2,$3,clock_timestamp()-interval '1 second')`,
          [proposed.id, shared.id, randomUUID()],
        );
        await request({ url: `${base}/actions/${proposed.id}`, headers: creator }, 404);
        await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
          f.members[1].membershipId,
        ]);
        await request({ url: `${base}/actions/${proposed.id}`, headers: creator }, 404);
        await request(
          {
            method: 'POST',
            url: `${base}/actions/${proposed.id}/reconciliation`,
            headers: creator,
            payload: {
              requestId: randomUUID(),
              digest: proposed.digest,
              outcome: 'not-performed',
              notes: 'Cannot take over.',
            },
          },
          404,
        );
        const status = await f.service.status(f.one.id, f.admin, shared.id);
        assert.equal(status.barrierActionId, null);
        assert.equal(status.blocked, true);
      },
    );
    await t.test(
      'revoked requester payload stays concealed while expired claim recovery continues with dispatch disabled',
      async () => {
        const proposed = await f.propose(integration);
        await f.service.decide(f.one.id, member, proposed.id, { digest: proposed.digest, decision: 'approve' });
        await f.db.platform.query(
          `INSERT INTO ${f.table('claims')} (action_id,integration_id,token,deadline) VALUES ($1,$2,$3,clock_timestamp()-interval '1 second')`,
          [proposed.id, integration.id, randomUUID()],
        );
        await f.service.setLifecycle(f.one.id, member, integration.id, 'disabled');
        const disabled = Fastify();
        registerWorkspaceMcp(
          disabled,
          auth,
          createWorkspaceMcpApi({
            ...f.options,
            service: f.make({ admissionEnabled: false, dispatchEnabled: false }),
            catalog,
            permissions,
            admissionEnabled: false,
            dispatchEnabled: false,
          }),
        );
        try {
          const response = await disabled.inject({
            url: `/workspaces/${f.one.id}/workspace-mcp/actions/${proposed.id}`,
            headers,
          });
          assert.equal(response.statusCode, 200, response.body);
          assert.equal(response.json().visibility, 'requester-metadata');
          assert.equal(response.json().canReconcile, true);
          assert.equal(response.body.includes('private input'), false);
          assert.equal(
            (await f.db.platform.query(`SELECT status FROM ${f.table('receipts')} WHERE action_id=$1`, [proposed.id]))
              .rows[0].status,
            'outcome-unknown',
          );
          assert.equal(f.calls.length, 0);
        } finally {
          await disabled.close();
        }
        integration = (await request({ url: `${base}/integrations/${integration.id}` }, 200)).integration;
      },
    );
    await t.test('separate kill switches keep status and revocation available', async () => {
      const disabled = Fastify();
      const locked = createWorkspaceMcpApi({
        ...f.options,
        service: f.make({ admissionEnabled: false, dispatchEnabled: false }),
        catalog,
        permissions,
        admissionEnabled: false,
        dispatchEnabled: false,
      });
      registerWorkspaceMcp(disabled, auth, locked);
      try {
        const path = `/workspaces/${f.one.id}/workspace-mcp`;
        assert.equal(
          (await disabled.inject({ url: `${path}/integrations/${integration.id}`, headers })).statusCode,
          200,
        );
        assert.equal(
          (
            await disabled.inject({
              method: 'POST',
              url: `${path}/integrations`,
              headers,
              payload: {
                requestId: randomUUID(),
                name: 'New',
                ownership: 'personal',
                endpoint: 'https://mcp.example.com/tools',
                auth: { kind: 'none' },
              },
            })
          ).statusCode,
          503,
        );
        const revoked = await disabled.inject({
          method: 'POST',
          url: `${path}/integrations/${integration.id}/lifecycle`,
          headers,
          payload: { requestId: randomUUID(), expectedVersion: integration.version, operation: 'disconnect' },
        });
        assert.equal(revoked.statusCode, 200, revoked.body);
      } finally {
        await disabled.close();
      }
    });
  } finally {
    await app.close();
    permissions.close();
    await f.close();
  }
});
