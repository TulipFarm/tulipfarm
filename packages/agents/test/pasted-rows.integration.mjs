import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createTableService } from '@tulipfarm/tables/service';
import { createTableExecution } from '@tulipfarm/tables/execution';
import { createTableProposalDecisions } from '@tulipfarm/tables/proposals';
import { fixture, loadPlatformBaseline } from '../../workspace-storage/test/integration/fixture.mjs';
import { createTableWithRows, tableDefinition, textField } from '../../tables/test/fixture.mjs';
import { createChatTools, parseToolCall } from '../src/tools.ts';
import { createChatTableProposals, tableProposalOptions } from '../src/table-proposals.ts';
import { requireTableSources } from '../src/table-sources.ts';

test(
  'pasted CSV uses normal proposal authority and adds exactly the reviewed rows once after approval',
  { timeout: 60000 },
  async t => {
    const db = await fixture();
    let runtime;
    t.after(async () => {
      await runtime?.close();
      await db.close();
    });
    await loadPlatformBaseline(db.platform);
    const workspace = await db.create(await workspaceTableMigrations());
    const s = `"${workspace.names.schema}"`;
    runtime = createWorkspaceRuntime({
      resolveCredential: async () => ({
        workspaceId: workspace.id,
        generation: 1,
        connectionString: db.login(workspace),
      }),
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
    });
    const actor = { kind: 'human', userId: workspace.userId, membershipId: workspace.membershipId };
    const team = randomUUID();
    await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Operations')`, [team]);
    const name = textField('Name');
    const status = {
      id: randomUUID(),
      label: 'Status',
      kind: 'single-select',
      required: false,
      options: [{ id: randomUUID(), label: 'Done', retired: false }],
    };
    const due = { id: randomUUID(), label: 'Due', kind: 'date', required: false };
    const definition = tableDefinition({ owningTeamId: team, label: 'Tasks', fields: [name, status, due] });
    const created = await createTableWithRows({ db, workspace, runtime, definition });
    const tools = createChatTools(runtime);
    const proposals = createChatTableProposals(runtime);
    const decisions = createTableProposalDecisions({
      ...tableProposalOptions(runtime),
      resolveConfirmationCredential: async () => db.login(workspace, 'confirmation'),
    });
    const advance = createTableExecution({
      requireSources: requireTableSources,
      resolveMigrationCredential: async () => db.login(workspace, 'migration'),
    });
    const service = createTableService(runtime, {}, commonCompatibility);
    let total = 0;
    for (let run = 0; run < 3; run++) {
      const chat = randomUUID(),
        turn = randomUUID(),
        message = randomUUID();
      const origin = {
        conversationId: chat,
        turnId: turn,
        sources: [{ kind: 'private-conversation', conversationId: chat }],
      };
      const csv = `Name,Status,Due\nsample-golf-${run},done,\nsample-hotel-${run},Done,2026-11-12`;
      await db.platform.query(
        `INSERT INTO ${s}.tf_conversations(id,owner_user_id,owner_membership_id) VALUES($1,$2,$3)`,
        [chat, actor.userId, actor.membershipId],
      );
      await db.platform.query(
        `INSERT INTO ${s}.tf_conversation_messages(id,conversation_id,sequence,author_kind,membership_id) VALUES($1,$2,1,'human',$3)`,
        [message, chat, actor.membershipId],
      );
      await db.platform.query(
        `INSERT INTO ${s}.tf_conversation_parts(conversation_id,message_id,ordinal,kind,text) VALUES($1,$2,0,'text',$3)`,
        [chat, message, `Import these rows into Tasks:\n${csv}`],
      );
      await db.platform.query(
        `INSERT INTO ${s}.tf_conversation_turns(id,conversation_id,source_message_id,accepted_sequence) VALUES($1,$2,$3,1)`,
        [turn, chat, message],
      );
      const invoke = call =>
        tools.invokeWithSources(
          { workspaceId: workspace.id, actor, origin, callId: randomUUID() },
          parseToolCall(call, { kind: 'chat' }),
        );
      const prepared = (await invoke({ tool: 'tables.import.paste', tableId: definition.id, csv })).result;
      assert.ok(prepared.input, JSON.stringify(prepared));
      const invalid = (
        await invoke({
          tool: 'tables.import.paste',
          tableId: definition.id,
          csv: 'Name,Status,Due\nsample-invalid,missing,no-date',
        })
      ).result;
      assert.equal(invalid.error, 'invalid-values');
      assert.equal(invalid.problems[0].label, 'sample-invalid');
      assert.equal(invalid.input, undefined);
      const empty = (await invoke({ tool: 'tables.import.paste', tableId: definition.id, csv: '' })).result;
      assert.equal(empty.reason, 'No review prepared: no rows were pasted. Paste the rows with a header row.');
      const proposal = (await invoke({ tool: 'tables.propose', input: JSON.stringify(prepared.input) })).result;
      assert.equal(proposal.status, 'pending', JSON.stringify(proposal));
      const view = await proposals.read(workspace.id, actor.userId, chat, proposal.id);
      assert.equal(view.manifest.plans.length, 1);
      assert.equal(view.manifest.plans[0].effectCount, 2);
      const effects = await proposals.effects(workspace.id, actor.userId, chat, proposal.id, definition.id, {});
      assert.deepEqual(effects.items.map(({ effect }) => effect.after[name.id].value).sort(), [
        `sample-golf-${run}`,
        `sample-hotel-${run}`,
      ]);
      assert.equal(
        effects.items.find(({ effect }) => effect.after[name.id].value === `sample-golf-${run}`).effect.after[due.id],
        null,
      );
      assert.ok(effects.items.every(({ effect }) => effect.after[status.id].optionId === status.options[0].id));
      const rows = () =>
        service.listPage(workspace.id, actor, { tableId: definition.id, revision: created.revision, query: {} });
      assert.equal((await rows()).records.length, total, 'preparation and proposal write no rows');
      assert.equal(await advance(workspace.id, proposal.id), 'blocked', 'execution cannot precede human approval');
      await decisions.decide(workspace.id, actor.userId, chat, proposal.id, {
        commandId: randomUUID(),
        digest: proposal.digest,
        decision: 'approve',
      });
      let outcome;
      for (let step = 0; step < 20; step++) {
        outcome = await advance(workspace.id, proposal.id);
        if (outcome === 'completed' || outcome === 'blocked') break;
      }
      assert.equal(outcome, 'completed');
      total += 2;
      assert.equal((await rows()).records.length, total);
      assert.equal(await advance(workspace.id, proposal.id), 'completed');
      assert.equal((await rows()).records.length, total, 'replaying approval execution creates no duplicate rows');
      assert.throws(
        () => parseToolCall({ tool: 'tables.import.paste', tableId: definition.id, csv }, { kind: 'agent', tools: [] }),
        AccessDenied,
      );
    }
  },
);
