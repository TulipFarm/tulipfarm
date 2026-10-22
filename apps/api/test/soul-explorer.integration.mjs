import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createAgentAuthoring } from '@tulipfarm/agents/authoring';
import { requireTableSources } from '@tulipfarm/agents/table-sources';
import { createTableProposals, createTableProposalDecisions } from '@tulipfarm/tables/proposals';
import { createTablePublication } from '@tulipfarm/tables/execution';
import { generationProposalData } from '@tulipfarm/tables/store';
import { prepareSoulRevision } from '@tulipfarm/workspaces/soul-revisions';
import {
  fixture,
  loadPlatformBaseline,
  markWorkspaceReady,
} from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { explorerStorage } from '../../../packages/workspaces/test/soul-explorer.fixture.mjs';
import { createSoulExplorerService, registerSoulExplorer } from '../src/soul-explorer.ts';

test(
  'Soul HTTP reads enforce current admin, file grants, flags and immutable accepted head',
  { timeout: 60000 },
  async () => {
    const db = await fixture();
    let runtime, app;
    try {
      await loadPlatformBaseline(db.platform);
      const workspace = await db.create(await workspaceTableMigrations());
      await markWorkspaceReady(db.platform, workspace.id);
      const table = name => `"${workspace.names.schema}"."${name}"`;
      const createdAt = (
        await db.platform.query('SELECT created_at FROM app.workspaces WHERE id=$1', [workspace.id])
      ).rows[0].created_at.toISOString();
      const seed = { workspaceId: workspace.id, createdBy: workspace.userId, createdAt };
      const f = await explorerStorage(seed);
      const send = f.storage.client.send;
      let duringRead;
      f.storage.client.send = async command => {
        const result = await send(command);
        if (duringRead) {
          const change = duringRead;
          duringRead = undefined;
          await change();
        }
        return result;
      };
      await db.platform.query(
        'UPDATE app.workspaces SET soul_commit=$2,soul_bucket=$3,soul_key=$4,ready_at=now() WHERE id=$1',
        [workspace.id, f.initial.commit, f.initial.bucket, f.initial.key],
      );
      await db.platform.query(`UPDATE ${table('tf_soul_head')} SET revision=$1`, [f.initial.commit]);
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(workspace) }),
      });
      const service = createSoulExplorerService(
        { runtime, pool: db.platform },
        () => f.storage,
        async () => true,
      );
      assert.equal((await service.tree(workspace.id, workspace.userId, {})).revision, f.initial.commit);
      let who = workspace.userId,
        enabled = true;
      app = Fastify();
      registerSoulExplorer(app, {
        runtime,
        pool: db.platform,
        storage: f.storage,
        enabled: async () => enabled,
        auth: { api: { getSession: async () => (who ? { user: { id: who } } : null) } },
      });
      const base = `/workspaces/${workspace.id}/soul`;
      const get = path => app.inject(`${base}${path}`);
      const initial = await get('/tree');
      assert.equal(initial.statusCode, 200, initial.body);
      assert.equal(initial.json().revision, f.initial.commit);
      assert.equal(initial.headers['cache-control'], 'no-store');
      const initialSnapshot = await get('/snapshot');
      assert.equal(initialSnapshot.statusCode, 200, initialSnapshot.body);
      assert.equal(initialSnapshot.headers['cache-control'], 'no-store');
      assert.equal(initialSnapshot.json().files.length, 8);
      const commands = createAgentAuthoring(runtime);
      const worker = commands.withWriter(input =>
        prepareSoulRevision(
          f.storage,
          seed,
          input.parent ? { ...input.parent, commit: input.expectedParentCommit, bucket: f.storage.bucket } : f.initial,
          {
            kind: 'agent',
            commandId: input.commandId,
            expectedParentCommit: input.expectedParentCommit,
            createdAt: input.createdAt,
            definition: input.definition,
          },
        ),
      );
      const agentId = randomUUID();
      const definition = {
        name: 'Read-only accountant',
        instructions: 'Read only the requested invoices.',
        tools: ['rows.list'],
        skills: [],
      };
      const command = await commands.save(workspace.id, who, agentId, {
        requestId: randomUUID(),
        expectedSoulRevision: f.initial.commit,
        expectedSavedRevision: null,
        owningTeamId: null,
        definition,
      });
      assert.equal((await worker.prepare(workspace.id, command.commandId)).status, 'accepted');
      const current = (await get('/tree')).json().revision;
      assert.notEqual(current, f.initial.commit);
      const path = `agents/${agentId}.json`;
      assert.equal((await get(`/tree?search=${agentId}`)).json().entries[0].path, path);
      const file = await get(`/file?${new URLSearchParams({ path, revision: current })}`);
      assert.equal(file.statusCode, 200, file.body);
      assert.deepEqual(JSON.parse(file.json().content), { formatVersion: 1, id: agentId, ...definition });
      assert.equal((await get('/snapshot')).json().files.find(file => file.path === path).content, file.json().content);
      assert.equal((await get(`/file?${new URLSearchParams({ path, revision: f.initial.commit })}`)).statusCode, 409);
      duringRead = () =>
        db.platform.query(`DELETE FROM ${table('tf_agent_person_grants')} WHERE agent_id=$1`, [agentId]);
      const revokedFile = await get('/snapshot');
      assert.equal(revokedFile.statusCode, 409, 'a file grant revoked during extraction discards all content');
      assert.ok(!revokedFile.body.includes(definition.instructions));
      assert.deepEqual((await get(`/tree?search=${agentId}`)).json().entries, []);
      assert.equal((await get(`/file?${new URLSearchParams({ path, revision: current })}`)).statusCode, 404);
      assert.ok(!(await get('/snapshot')).body.includes(agentId), 'withhold denied names and contents in the snapshot');
      const team = randomUUID(),
        chat = randomUUID(),
        message = randomUUID(),
        turn = randomUUID();
      await db.platform.query(`INSERT INTO ${table('tf_teams')}(id,name) VALUES($1,'Finance')`, [team]);
      await db.platform.query(
        `INSERT INTO ${table('tf_conversations')}(id,owner_user_id,owner_membership_id) VALUES($1,$2,$3)`,
        [chat, who, workspace.membershipId],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_conversation_messages')}(id,conversation_id,sequence,author_kind,membership_id) VALUES($1,$2,1,'human',$3)`,
        [message, chat, workspace.membershipId],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_conversation_turns')}(id,conversation_id,source_message_id,accepted_sequence) VALUES($1,$2,$3,1)`,
        [turn, chat, message],
      );
      const access = { runtime, requireSources: requireTableSources, data: generationProposalData };
      const proposals = createTableProposals(access);
      const decisions = createTableProposalDecisions({
        ...access,
        resolveConfirmationCredential: async () => db.login(workspace, 'confirmation'),
      });
      const tableDefinition = {
        formatVersion: 2,
        id: randomUUID(),
        owningTeamId: team,
        label: 'Unapplied invoices',
        fields: [{ id: randomUUID(), label: 'Number', kind: 'text', required: true, maxLength: 120 }],
        uniqueKeys: [],
      };
      const proposal = await proposals.propose(
        workspace.id,
        { kind: 'human', userId: who, membershipId: workspace.membershipId },
        randomUUID(),
        { conversationId: chat, turnId: turn, sources: [{ kind: 'private-conversation', conversationId: chat }] },
        {
          plans: [
            {
              kind: 'schema',
              tableId: tableDefinition.id,
              dependsOn: [],
              expectedRevision: null,
              target: tableDefinition,
              transforms: { outputs: [] },
            },
          ],
        },
      );
      await decisions.decide(workspace.id, who, chat, proposal.id, {
        digest: proposal.digest,
        commandId: randomUUID(),
        decision: 'approve',
      });
      const publish = createTablePublication({
        runtime,
        requireSources: requireTableSources,
        prepareRevision: input =>
          prepareSoulRevision(
            f.storage,
            seed,
            input.parent
              ? { ...input.parent, commit: input.expectedParentCommit, bucket: f.storage.bucket }
              : f.initial,
            {
              kind: 'table',
              commandId: input.commandId,
              expectedParentCommit: input.expectedParentCommit,
              createdAt: input.createdAt,
              definition: input.definition,
            },
          ),
      });
      assert.equal(await publish(workspace.id, proposal.id), 'ready');
      const tableHead = (await get('/tree')).json().revision;
      assert.notEqual(tableHead, current);
      const tablePath = `tables/${tableDefinition.id}.json`;
      const tableFile = await get(`/file?${new URLSearchParams({ path: tablePath, revision: tableHead })}`);
      assert.equal(tableFile.statusCode, 200, tableFile.body);
      assert.deepEqual(JSON.parse(tableFile.json().content), tableDefinition);
      assert.equal(
        (await db.platform.query(`SELECT id FROM ${table('tf_table_catalog')} WHERE id=$1`, [tableDefinition.id]))
          .rowCount,
        0,
        'accepted creation is readable even before its first table generation exists',
      );
      const beforeSnapshot = f.reads.length;
      const tableSnapshot = await get('/snapshot');
      assert.equal(tableSnapshot.statusCode, 200, tableSnapshot.body);
      assert.equal(f.reads.length - beforeSnapshot, 1);
      assert.equal(tableSnapshot.json().revision, tableHead);
      assert.deepEqual(
        JSON.parse(tableSnapshot.json().files.find(file => file.path === tablePath).content),
        tableDefinition,
      );
      duringRead = () =>
        db.platform.query(`UPDATE ${table('tf_memberships')} SET role='member' WHERE id=$1`, [workspace.membershipId]);
      assert.equal(
        (await get('/snapshot')).statusCode,
        404,
        'revocation during bundle extraction must discard the response',
      );
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET role='admin' WHERE id=$1`, [
        workspace.membershipId,
      ]);
      duringRead = () => db.platform.query(`UPDATE ${table('tf_soul_head')} SET revision=$1`, [f.initial.commit]);
      assert.equal((await get('/snapshot')).statusCode, 409, 'a head change during extraction must require Refresh');
      await db.platform.query(`UPDATE ${table('tf_soul_head')} SET revision=$1`, [tableHead]);
      duringRead = async () => {
        enabled = false;
      };
      assert.equal((await get('/snapshot')).statusCode, 404, 'flag revocation during extraction discards all content');
      enabled = true;
      for (const invalid of ['../soul.json', '.git/config'])
        assert.equal((await get(`/file?${new URLSearchParams({ path: invalid, revision: current })}`)).statusCode, 400);
      enabled = false;
      const reads = f.reads.length;
      assert.equal((await get('/tree')).statusCode, 404);
      assert.equal((await get('/snapshot')).statusCode, 404);
      assert.equal(f.reads.length, reads);
      enabled = true;
      const providerFailure = createSoulExplorerService(
        { runtime, pool: db.platform },
        () => f.storage,
        async () => {
          throw new Error('Flag provider unavailable');
        },
      );
      await assert.rejects(providerFailure.repository(workspace.id, workspace.userId), /Flag provider unavailable/);
      assert.equal(f.reads.length, reads);
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET role='member' WHERE id=$1`, [
        workspace.membershipId,
      ]);
      assert.equal((await get('/tree')).statusCode, 404);
      assert.equal((await get('/snapshot')).statusCode, 404);
      who = randomUUID();
      assert.equal((await get('/tree')).statusCode, 404);
      assert.equal((await get('/snapshot')).statusCode, 404);
      who = null;
      assert.equal((await get('/tree')).statusCode, 401);
      assert.equal((await get('/snapshot')).statusCode, 401);
      who = workspace.userId;
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET role='admin' WHERE id=$1`, [
        workspace.membershipId,
      ]);
      await db.platform.query(`UPDATE ${table('tf_soul_head')} SET revision=$1`, ['0'.repeat(40)]);
      assert.equal((await get('/tree')).statusCode, 503);
      assert.equal(f.reads.length, reads);
    } finally {
      await app?.close();
      await runtime?.close();
      await db.close();
    }
  },
);
