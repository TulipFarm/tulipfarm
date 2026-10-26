import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { initializeSoul, soulStorageConfig } from '@tulipfarm/workspaces/soul';
import { prepareSoulRevision, readVerifiedProjection } from '@tulipfarm/workspaces/soul-revisions';
import { createConversations } from '../../conversations/src/index.ts';
import { createConversationExecutor } from '../../conversations/src/runtime.ts';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAuthoringDrafts } from '../src/drafts.ts';
import { createChatTools } from '../src/tools.ts';
import { createAgentAuthoring } from '../src/authoring.ts';
import { soulStorageSkip } from './soul-fixture.mjs';

test(
  'review repro: source revocation before Soul publication must prevent saving the queued draft',
  { skip: soulStorageSkip },
  async t => {
    const db = await fixture(),
      soul = soulStorageConfig();
    let runtime;
    t.after(async () => {
      await runtime?.close();
      soul.client.destroy();
      await db.close();
    });
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const w = await db.create(await workspaceTableMigrations());
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
    });
    const table = name => `"${w.names.schema}".${name}`;
    const member = randomUUID(),
      user = randomUUID(),
      team = randomUUID(),
      resource = randomUUID();
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      member,
      user,
    ]);
    await db.platform.query(`INSERT INTO ${table('tf_teams')} (id,name) VALUES ($1,'Authors')`, [team]);
    await db.platform.query(`INSERT INTO ${table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
      member,
      team,
    ]);
    await db.platform.query(
      `INSERT INTO ${table('tf_agent_creation_grants')} (team_id,owning_team_id) VALUES ($1,$1)`,
      [team],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_table_catalog')} (id,owning_team_id,physical_table,display_name,target_revision) VALUES ($1,$2,'review_source','Source','fixture')`,
      [resource, team],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,'table.row.read')`,
      [team, resource],
    );
    const seed = { workspaceId: w.id, createdBy: user, createdAt: new Date().toISOString() },
      initial = await initializeSoul(soul, seed);
    await db.platform.query(`UPDATE ${table('tf_soul_head')} SET revision=$1 WHERE id=1`, [initial.commit]);
    const chats = createConversations(runtime),
      drafts = createAuthoringDrafts(runtime),
      chatId = randomUUID();
    await chats.create(w.id, user, { chatId, commandId: randomUUID() });
    const first = await chats.send(w.id, user, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      parts: [{ kind: 'text', text: 'Inspect source' }],
    });
    await createConversationExecutor(runtime, async () => ({
      text: 'Sensitive source instruction',
      sources: [{ kind: 'table', tableId: resource }],
    })).process({ workspaceId: w.id, conversationId: chatId, turnId: first.turnId, generation: 0 });
    const sent = await chats.send(w.id, user, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      parts: [{ kind: 'text', text: 'Draft from source' }],
    });
    let draft;
    const executor = createConversationExecutor(runtime, async ({ executeTool }) => {
      draft = await executeTool('agents.draft', false, context =>
        createChatTools(context.runtime).invoke(context, {
          tool: 'agents.draft',
          agent: 'new',
          input: {
            expectedSoulRevision: initial.commit,
            owningTeamId: team,
            definition: { name: 'Derived helper', instructions: 'Sensitive source instruction', tools: [] },
          },
        }),
      );
      return 'Review the draft';
    });
    assert.equal(
      await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
      'completed',
    );
    const agentId = draft.agentId;
    const outcome = await drafts.decide(w.id, user, chatId, draft.draftId, {
      commandId: randomUUID(),
      digest: draft.digest,
      decision: 'save',
    });
    assert.equal(outcome.receipt.status, 'preparing');
    await db.platform.query(`DELETE FROM ${table('tf_grants')} WHERE asset_id=$1`, [resource]);
    await assert.rejects(drafts.read(w.id, user, chatId, draft.draftId));
    const worker = createAgentAuthoring(runtime).withWriter(input =>
      prepareSoulRevision(
        soul,
        seed,
        input.parent ? { commit: input.expectedParentCommit, bucket: soul.bucket, ...input.parent } : initial,
        {
          kind: 'agent',
          commandId: input.commandId,
          expectedParentCommit: input.expectedParentCommit,
          createdAt: input.createdAt,
          definition: input.definition,
        },
      ),
    );
    const published = await worker.prepare(w.id, outcome.receipt.commandId);
    if (published.status === 'accepted') {
      const row = (
        await db.platform.query(`SELECT projection FROM ${table('tf_agent_saved_revisions')} WHERE agent_id=$1`, [
          agentId,
        ])
      ).rows[0];
      assert.equal(
        (await readVerifiedProjection(soul, w.id, row.projection)).instructions,
        'Sensitive source instruction',
      );
    }
    assert.equal(published.status, 'failed', 'revoked source must fence queued Soul publication');
  },
);
