import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { commonCompatibility, createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { verifyWorkspaceIsolation } from '@tulipfarm/workspace-storage/provisioning';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createWorkspaceMcp } from '../dist/index.js';

export async function mcpFixture() {
  const db = await fixture();
  let runtime;
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const stream = await workspaceTableMigrations();
    assert.equal(stream.length, commonCompatibility.maximum);
    const one = await db.create(stream);
    const table = (name, workspace = one) =>
      qualified(workspace.names.schema, name.startsWith('tf_') ? name : `tf_mcp_${name}`);
    const two = await db.create(stream);
    for (const workspace of [one, two]) {
      const receipts = (
        await db.platform.query(`SELECT name, checksum FROM ${table('tf_common_migrations', workspace)} ORDER BY name`)
      ).rows;
      assert.deepEqual(
        receipts,
        stream.map(({ name, checksum }) => ({ name, checksum })),
      );
      await verifyWorkspaceIsolation(db.platform, workspace.id);
    }
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      maxPools: 2,
      connectionsPerPool: 4,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => {
        const workspace = db.workspaces.find(workspace => workspace.id === id);
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
    const origins = new Map();
    const sources = new Set();
    const calls = [];
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
    let discover = async () => ({ tools });
    const options = {
      runtime,
      keyring: { activeKeyId: 'test', keys: { test: 'ab'.repeat(32) } },
      admissionEnabled: true,
      dispatchEnabled: true,
      resolveConfirmationCredential: async id =>
        db.login(
          db.workspaces.find(workspace => workspace.id === id),
          'confirmation',
        ),
      protocol: {
        discover: input => discover(input),
        call: async input => {
          calls.push(input);
          return call(input);
        },
      },
      authorizeOrigin: async ({ actor, origin }) => {
        const authorized = origins.get(origin.kind === 'private-chat' ? origin.conversationId : origin.taskId);
        if (!authorized || authorized.membershipId !== actor.membershipId || authorized.revoked)
          throw new Error('origin denied');
        return { sources: authorized.sources ?? [], allowedTools: authorized.allowedTools ?? null };
      },
      authorizeSources: async ({ sources: dependencies }) => {
        if (dependencies.some(source => source.kind === 'table' && !sources.has(source.tableId)))
          throw new Error('source denied');
      },
      authorizeSelection: async ({ actor, subject }) => {
        const authorized = origins.get(subject.id);
        if (!authorized || authorized.membershipId !== actor.membershipId || authorized.revoked)
          throw new Error('selection denied');
        return { sources: authorized.sources ?? [], slots: subject.kind === 'chat' ? null : (authorized.slots ?? []) };
      },
    };
    const make = overrides => createWorkspaceMcp({ ...options, ...overrides });
    const service = make();
    function origin(actor = members[0], kind = 'private-chat') {
      const id = randomUUID();
      const origin =
        kind === 'private-chat'
          ? { kind, conversationId: id, turnId: randomUUID(), stepId: randomUUID() }
          : { kind, taskId: id, stepId: randomUUID() };
      origins.set(id, { membershipId: actor.membershipId });
      return origin;
    }
    async function connect(
      actor = members[0],
      ownership = 'personal',
      credential = { kind: 'bearer', token: 'synthetic-private-mcp-secret' },
    ) {
      const integration = await service.create(one.id, actor, {
        name: 'My MCP',
        endpoint: 'https://mcp.example.com/tools',
        ownership,
        credential,
      });
      const discovered = await service.discover(one.id, actor, integration.id);
      await service.reviewTools(
        one.id,
        actor,
        integration.id,
        discovered.map(tool => ({
          name: tool.name,
          revision: tool.discovered_revision,
          enabled: true,
          standingException: true,
        })),
      );
      return integration;
    }
    async function select(integration, actor = members[0], selectedOrigin = origin(actor)) {
      const current = await service.selection(one.id, actor, selectedOrigin);
      await service.setSelection(one.id, actor, {
        origin: selectedOrigin,
        expectedVersion: current.version,
        integrationIds: [integration.id],
      });
      return selectedOrigin;
    }
    async function propose(integration, actor = members[0], selectedOrigin, toolName = 'write') {
      const context = selectedOrigin ?? (await select(integration, actor));
      const catalog = await service.catalog(one.id, actor, context);
      const tool = catalog.tools.find(tool => tool.tool.name === toolName);
      assert.ok(tool);
      const action = await service.propose(one.id, actor, {
        id: randomUUID(),
        origin: context,
        handle: tool.handle,
        arguments: toolName === 'write' ? { text: 'private input' } : {},
      });
      return action;
    }
    async function approve(action, actor = members[0]) {
      return service.decide(one.id, actor, action.id, { digest: action.digest, decision: 'approve' });
    }
    return {
      db,
      one,
      two,
      runtime,
      table,
      admin,
      members,
      origins,
      sources,
      calls,
      options,
      make,
      service,
      origin,
      connect,
      select,
      propose,
      approve,
      setTools(value) {
        tools = value;
      },
      getTools() {
        return tools;
      },
      setCall(value) {
        call = value;
      },
      setDiscover(value) {
        discover = value;
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
