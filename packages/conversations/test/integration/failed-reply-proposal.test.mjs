import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { requireDraftSources } from '../../../agents/src/draft-sources.ts';
import { createTableProposalDecisions, createTableProposals } from '../../../tables/dist/proposals.js';
import { createConversationExecutor } from '../../src/runtime.ts';
import { conversationFixture } from '../fixture.mjs';

// The provider fails the reply after `tables.propose` saved a proposal: only the reply text is lost.
test('a reply that fails after saving a table proposal keeps the proposal reviewable', async () => {
  const f = await conversationFixture();
  try {
    const w = f.workspace,
      chatId = randomUUID(),
      teamId = randomUUID(),
      tableId = randomUUID();
    await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'Sales')`, [teamId]);
    const options = { runtime: f.runtime, requireSources: requireDraftSources };
    const proposals = createTableProposals(options);
    const decisions = createTableProposalDecisions({
      ...options,
      resolveConfirmationCredential: async () => f.db.login(w, 'confirmation'),
    });
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const sent = await f.store.send(w.id, w.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'Create a customers table' }],
    });
    const input = {
      plans: [
        {
          kind: 'schema',
          tableId,
          dependsOn: [],
          expectedRevision: null,
          target: {
            formatVersion: 2,
            id: tableId,
            owningTeamId: teamId,
            label: 'Customers',
            fields: [{ id: randomUUID(), label: 'Name', kind: 'text', required: false, maxLength: 200 }],
            uniqueKeys: [],
          },
          transforms: { outputs: [] },
        },
      ],
    };
    let proposal;
    const executor = createConversationExecutor(f.runtime, async ({ executeTool }) => {
      await executeTool(
        'tables.propose',
        false,
        async ({ runtime, actor, callId, origin }) => {
          proposal = await createTableProposals({ ...options, runtime }).propose(w.id, actor, callId, origin, input);
          return { result: proposal, sources: [] };
        },
        [],
        { tool: 'tables.propose', input: JSON.stringify(input) },
      );
      throw new Error('model-incomplete-response');
    });
    assert.equal(
      await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
      'failed',
    );
    const reply = async () =>
      (await f.store.history(w.id, w.userId, chatId)).messages.find(message => message.turn?.id === sent.turnId);

    const failed = await reply();
    assert.equal(failed.turn.status, 'failed');
    assert.equal(failed.turn.errorCode, 'model-incomplete-response');
    assert.equal(failed.tools.length, 1);
    const [tool] = failed.tools;
    assert.equal(tool.tool, 'tables.propose');
    assert.equal(tool.status, 'completed', 'the failed reply leaves its saved proposal step completed');
    assert.equal(tool.id, proposal.id, 'the review card reads the proposal saved by this step');
    assert.equal(tool.tableProposal, true, 'history marks the step that saved a proposal');
    assert.equal(tool.activityStatus, 'waiting');
    assert.equal(
      (await proposals.status(w.id, w.userId, chatId, proposal.id)).status,
      'pending',
      'the proposal stays pending for review after the reply failed',
    );

    await decisions.decide(w.id, w.userId, chatId, proposal.id, {
      digest: proposal.digest,
      decision: 'approve',
      commandId: randomUUID(),
    });
    const approved = await reply();
    assert.equal(approved.turn.status, 'failed');
    assert.equal(approved.tools[0].tableProposal, true);
    assert.equal(approved.tools[0].activityStatus, 'running', 'approval moves the step off waiting');

    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_table_proposal_receipts')} (proposal_id,table_id,attempt,receipt) VALUES ($1,$2,0,$3)`,
      [proposal.id, tableId, JSON.stringify({ status: 'completed' })],
    );
    const applied = await reply();
    assert.equal(applied.tools[0].tableProposal, true);
    assert.equal(applied.tools[0].activityStatus, 'completed');
  } finally {
    await f.close();
  }
});
