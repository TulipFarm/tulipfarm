import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { fixture, loadPlatformBaseline } from '../../workspace-storage/test/integration/fixture.mjs';
import { requireCommandDraftSources } from '../src/draft-sources.ts';
import { withHuman } from '../src/saved-policy.ts';

test('an approved agent draft from a chat that read memory stays usable by its author only', async t => {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  await loadPlatformBaseline(db.platform);
  const w = await db.create(await workspaceTableMigrations());
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async () => ({ workspaceId: w.id, generation: 1, connectionString: db.login(w) }),
  });
  const table = name => `"${w.names.schema}".${name}`;
  const chatId = randomUUID(),
    messageId = randomUUID(),
    turnId = randomUUID();
  await db.platform.query(
    `INSERT INTO ${table('tf_conversations')} (id,owner_user_id,owner_membership_id,next_message_sequence) VALUES ($1,$2,$3,2)`,
    [chatId, w.userId, w.membershipId],
  );
  await db.platform.query(
    `INSERT INTO ${table('tf_conversation_messages')} (id,conversation_id,sequence,author_kind,membership_id) VALUES ($1,$2,1,'human',$3)`,
    [messageId, chatId, w.membershipId],
  );
  await db.platform.query(
    `INSERT INTO ${table('tf_conversation_turns')} (id,conversation_id,source_message_id,accepted_sequence,responder) VALUES ($1,$2,$3,1,'reverse-text-v1')`,
    [turnId, chatId, messageId],
  );
  async function approvedDraft(sequence, memoryOf) {
    const draftId = randomUUID(),
      commandId = randomUUID();
    await db.platform.query(
      `INSERT INTO ${table('tf_conversation_tool_calls')} (id,conversation_id,turn_id,sequence,tool,status) VALUES ($1,$2,$3,$4,'agents.draft','completed')`,
      [draftId, chatId, turnId, sequence],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_chat_authoring_drafts')} (id,conversation_id,turn_id,membership_id,user_id,proposal,digest,sources) VALUES ($1,$2,$3,$4,$5,'{}',$6,$7)`,
      [
        draftId,
        chatId,
        turnId,
        w.membershipId,
        w.userId,
        'a'.repeat(64),
        JSON.stringify([{ kind: 'personal-memory', membershipId: memoryOf }]),
      ],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_chat_authoring_decisions')} (draft_id,membership_id,command_id,input,outcome) VALUES ($1,$2,$3,'{}',$4)`,
      [draftId, w.membershipId, randomUUID(), JSON.stringify({ kind: 'agent', receipt: { commandId } })],
    );
    return commandId;
  }
  const check = commandId =>
    withHuman(runtime, w.id, w.userId, 'read', (tx, actor) => requireCommandDraftSources(tx, actor, commandId));

  await check(await approvedDraft(1, w.membershipId));
  await assert.rejects(check(await approvedDraft(2, randomUUID())), AccessDenied);
});
