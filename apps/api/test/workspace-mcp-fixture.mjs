import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '../../../packages/workspaces/src/table-migrations.ts';
import { createWorkspaceMcp } from '@tulipfarm/workspace-mcp';
import { authorizeMcpOrigin, authorizeMcpSources, authorizeMcpSelection } from '@tulipfarm/agents/mcp-authority';

export async function apiMcpFixture(overrides = {}) {
  const db = await fixture();
  let runtime;
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const migrations = await workspaceTableMigrations();
    assert.equal(migrations.length, 9);
    const one = await db.create(migrations);
    const two = await db.create(migrations);
    const table = (name, workspace = one) =>
      qualified(workspace.names.schema, name.startsWith('tf_') ? name : `tf_mcp_${name}`);
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      maxPools: 2,
      connectionsPerPool: 4,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => {
        const workspace = db.workspaces.find(item => item.id === id);
        assert.ok(workspace);
        return { workspaceId: id, generation: 1, connectionString: db.login(workspace) };
      },
    });
    const members = [0, 1].map(() => ({ kind: 'human', userId: randomUUID(), membershipId: randomUUID() }));
    for (const member of members)
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        member.membershipId,
        member.userId,
      ]);
    const admin = { kind: 'human', userId: one.userId, membershipId: one.membershipId };
    let tools = [
      {
        name: 'write',
        description: 'Write a record',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
      },
      { name: 'read', description: 'Read a record', inputSchema: { type: 'object', additionalProperties: false } },
    ];
    let call = async () => ({ content: [{ type: 'text', text: 'provider result' }] });
    const calls = [];
    const options = {
      runtime,
      keyring: { activeKeyId: 'test', keys: { test: 'ab'.repeat(32) } },
      admissionEnabled: true,
      dispatchEnabled: true,
      resolveConfirmationCredential: async id =>
        db.login(
          db.workspaces.find(item => item.id === id),
          'confirmation',
        ),
      protocol: {
        discover: async () => ({ tools }),
        call: async input => {
          calls.push(input);
          return call(input);
        },
      },
      authorizeOrigin: authorizeMcpOrigin,
      authorizeSources: authorizeMcpSources,
      authorizeSelection: authorizeMcpSelection,
      ...overrides,
    };
    const make = overrides => createWorkspaceMcp({ ...options, ...overrides });
    const service = make();
    async function origin(actor = members[0]) {
      const conversationId = randomUUID(),
        turnId = randomUUID(),
        stepId = randomUUID(),
        messageId = randomUUID();
      await db.platform.query(
        `INSERT INTO ${table('tf_conversations')} (id,owner_user_id,owner_membership_id) VALUES ($1,$2,$3)`,
        [conversationId, actor.userId, actor.membershipId],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_conversation_messages')} (id,conversation_id,sequence,author_kind,membership_id) VALUES ($1,$2,1,'human',$3)`,
        [messageId, conversationId, actor.membershipId],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_conversation_turns')} (id,conversation_id,source_message_id,accepted_sequence) VALUES ($1,$2,$3,1)`,
        [turnId, conversationId, messageId],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_conversation_tool_calls')} (id,conversation_id,turn_id,sequence,tool,status) VALUES ($1,$2,$3,1,'mcp.call','running')`,
        [stepId, conversationId, turnId],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_conversation_execution_steps')} (call_id,turn_id,call,sources) VALUES ($1,$2,$3,$4)`,
        [stepId, turnId, { tool: 'mcp.call' }, JSON.stringify([{ kind: 'private-conversation', conversationId }])],
      );
      return { kind: 'private-chat', conversationId, turnId, stepId };
    }
    async function propose(integration, actor = members[0], context) {
      const selectedOrigin = context ?? (await origin(actor));
      const current = await service.selection(one.id, actor, selectedOrigin);
      await service.setSelection(one.id, actor, {
        origin: selectedOrigin,
        expectedVersion: current.version,
        integrationIds: [integration.id],
      });
      const catalog = await service.catalog(one.id, actor, selectedOrigin);
      const selected = catalog.tools.find(entry => entry.tool.name === 'write');
      assert.ok(selected);
      return service.propose(one.id, actor, {
        id: selectedOrigin.stepId,
        origin: selectedOrigin,
        handle: selected.handle,
        arguments: { text: 'private input' },
      });
    }
    return {
      db,
      one,
      two,
      runtime,
      table,
      admin,
      members,
      options,
      service,
      make,
      origin,
      propose,
      calls,
      setTools(value) {
        tools = value;
      },
      setCall(value) {
        call = value;
      },
      async close() {
        await runtime.close();
        await db.close();
      },
    };
  } catch (error) {
    await runtime?.close();
    await db.close();
    throw error;
  }
}
