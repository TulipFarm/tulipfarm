import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { apiMcpFixture } from './workspace-mcp-fixture.mjs';
import { workspaceMcpActions } from '../src/workspace-mcp-actions.ts';
import {
  mcpActionSchema,
  mcpActionListSchema,
  mcpActionQuery,
  mcpReconciliationSchema,
} from '../src/workspace-mcp-contracts.ts';
import {
  actionSchema as browserActionSchema,
  actionsSchema as browserActionsSchema,
} from '../../web/src/features/workspace-mcp/contracts.ts';

test('requester metadata recovery survives source revoke, disable, disconnect, reconnect, and grant loss without replay', async t => {
  const f = await apiMcpFixture();
  const actor = f.members[0];
  const api = workspaceMcpActions({ ...f.options, service: f.service });
  const app = Fastify();
  app.get('/actions/:id', async request =>
    mcpActionSchema.parse(await api.action(f.one.id, actor.userId, request.params.id)),
  );
  app.get('/actions', async request =>
    mcpActionListSchema.parse(await api.actions(f.one.id, actor.userId, mcpActionQuery.parse(request.query))),
  );
  app.post('/actions/:id/reconciliation', async request =>
    mcpActionSchema.parse(
      await api.reconcile(f.one.id, actor.userId, request.params.id, mcpReconciliationSchema.parse(request.body)),
    ),
  );
  async function request(options) {
    const response = await app.inject(options);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.body.includes('private input'), false);
    assert.equal(response.body.includes('private evidence'), false);
    return response.json();
  }
  async function connect(owner = actor, ownership = 'personal') {
    const integration = await f.service.create(f.one.id, owner, {
      name: 'Recovery test',
      endpoint: 'https://mcp.example.com/tools',
      ownership,
      credential: { kind: 'none' },
    });
    const tools = await f.service.discover(f.one.id, owner, integration.id);
    await f.service.reviewTools(
      f.one.id,
      owner,
      integration.id,
      tools.map(tool => ({
        name: tool.name,
        revision: tool.discovered_revision,
        enabled: true,
        standingException: false,
      })),
    );
    return integration;
  }
  function concealed(value) {
    assert.equal(value.visibility, 'requester-metadata');
    assert.equal(value.exact, undefined);
    assert.equal(value.receipt, null);
    assert.equal(value.canDecide, false);
    assert.deepEqual(browserActionSchema.parse(value), value);
    if (value.reconciliation) assert.equal(value.reconciliation.notes, '');
  }
  try {
    for (const change of ['source-revoke', 'disabled', 'disconnected', 'reconnected', 'grant-revoked'])
      await t.test(change, async () => {
        const shared = change === 'grant-revoked';
        const integration = await connect(shared ? f.admin : actor, shared ? 'shared' : 'personal');
        if (shared) {
          await f.service.setGrants(f.one.id, f.admin, integration.id, {
            expectedVersion: 1,
            memberIds: [actor.membershipId],
            teamIds: [],
          });
          const tools = await f.service.tools(f.one.id, f.admin, integration.id);
          await f.service.reviewTools(
            f.one.id,
            f.admin,
            integration.id,
            tools.map(tool => ({
              name: tool.name,
              revision: tool.discovered_revision,
              enabled: true,
              standingException: false,
            })),
          );
        }
        const origin = await f.origin(actor);
        const upstream = change === 'source-revoke' ? await connect() : null;
        if (upstream)
          await f.db.platform.query(
            `UPDATE ${f.table('tf_conversation_execution_steps')} SET sources=$2 WHERE call_id=$1`,
            [
              origin.stepId,
              JSON.stringify([
                { kind: 'private-conversation', conversationId: origin.conversationId },
                {
                  kind: 'mcp-integration',
                  integrationId: upstream.id,
                  authorizationEpoch: upstream.authorizationEpoch,
                },
              ]),
            ],
          );
        const proposed = await f.propose(integration, actor, origin);
        await f.service.decide(f.one.id, actor, proposed.id, { digest: proposed.digest, decision: 'approve' });
        f.setCall(async () => {
          throw new Error('unknown provider outcome');
        });
        const calls = f.calls.length;
        assert.equal((await f.service.dispatch(f.one.id, proposed.id)).status, 'outcome-unknown');
        await f.service.reconcile(f.one.id, actor, proposed.id, {
          observation: 'still-unknown',
          notes: 'private evidence before revocation',
        });
        if (upstream) await f.service.setLifecycle(f.one.id, actor, upstream.id, 'disconnected');
        else if (shared)
          await f.service.setGrants(f.one.id, f.admin, integration.id, {
            expectedVersion: 2,
            memberIds: [],
            teamIds: [],
          });
        else {
          await f.service.setLifecycle(
            f.one.id,
            actor,
            integration.id,
            change === 'disabled' ? 'disabled' : 'disconnected',
          );
          if (change === 'reconnected')
            await f.service.replaceCredential(f.one.id, actor, integration.id, {
              expectedSecretVersion: 1,
              credential: { kind: 'none' },
            });
        }
        await assert.rejects(f.service.action(f.one.id, actor, proposed.id));
        const status = await request({ url: `/actions/${proposed.id}` });
        concealed(status);
        assert.equal(status.digest, proposed.digest);
        assert.equal(status.integrationPaused, true);
        assert.equal(status.canReconcile, true);
        for (const [kind, originId] of [
          ['integration', integration.id],
          ['chat', origin.conversationId],
        ]) {
          const page = await request({ url: `/actions?kind=${kind}&originId=${originId}` });
          assert.deepEqual(browserActionsSchema.parse(page), page);
          assert.equal(page.actions.length, 1);
          concealed(page.actions[0]);
        }
        for (const other of [f.members[1], f.admin]) {
          await assert.rejects(api.action(f.one.id, other.userId, proposed.id));
          assert.deepEqual(
            (await api.actions(f.one.id, other.userId, { kind: 'integration', originId: integration.id })).actions,
            [],
          );
        }
        const still = await request({
          method: 'POST',
          url: `/actions/${proposed.id}/reconciliation`,
          payload: {
            requestId: randomUUID(),
            digest: status.digest,
            outcome: 'still-unknown',
            notes: 'private evidence remains inconclusive',
          },
        });
        concealed(still);
        assert.equal(still.integrationPaused, true);
        const payload = {
          requestId: randomUUID(),
          digest: status.digest,
          outcome: 'not-performed',
          notes: 'private evidence confirms no operation',
        };
        const complete = await request({ method: 'POST', url: `/actions/${proposed.id}/reconciliation`, payload });
        concealed(complete);
        assert.equal(complete.status, 'outcome-unknown');
        assert.equal(complete.integrationPaused, false);
        assert.equal(complete.canReconcile, false);
        assert.equal(complete.reconciliation.outcome, 'not-performed');
        assert.deepEqual(
          await request({ method: 'POST', url: `/actions/${proposed.id}/reconciliation`, payload }),
          complete,
        );
        const metadataOnly = workspaceMcpActions({
          ...f.options,
          service: f.make({
            authorizeOrigin: async () => {
              throw new Error('payload reads unavailable');
            },
            authorizeSources: async () => {
              throw new Error('payload reads unavailable');
            },
          }),
        });
        assert.deepEqual(await metadataOnly.reconcile(f.one.id, actor.userId, proposed.id, payload), complete);
        assert.equal((await f.make().dispatch(f.one.id, proposed.id)).status, 'outcome-unknown');
        assert.equal(f.calls.length, calls + 1);
        assert.deepEqual(
          (
            await f.db.platform.query(`SELECT status,result FROM ${f.table('receipts')} WHERE action_id=$1`, [
              proposed.id,
            ])
          ).rows,
          [{ status: 'outcome-unknown', result: null }],
        );
        assert.equal(
          (
            await f.db.platform.query(
              `SELECT 1 FROM ${f.table('reconciliations')} WHERE action_id=$1 AND observation='not-performed'`,
              [proposed.id],
            )
          ).rowCount,
          1,
        );
      });
  } finally {
    await app.close();
    await f.close();
  }
});
