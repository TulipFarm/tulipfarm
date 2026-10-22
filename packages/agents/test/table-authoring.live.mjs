import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { conversationFixture } from '../../conversations/test/fixture.mjs';
import { createConversationExecutor } from '@tulipfarm/conversations/runtime';
import { createChatTools, isExternalTool } from '../src/tools.ts';
import { createChatTableProposals } from '../src/table-proposals.ts';
import { inferWithTools } from '../src/inference.ts';
import { modelEnvironment } from '../src/model-environment.ts';

const family = process.env.TABLE_QA_MODEL;
test(
  'live model prepares an admin table review and reports failures without inventing permission denial',
  { skip: !family, timeout: 240000 },
  async t => {
    const route = modelEnvironment()?.route(family);
    assert.ok(route, 'Configure TABLE_QA_MODEL, MODEL_FAMILIES and its server credentials');
    const f = await conversationFixture();
    t.after(() => f.close());
    const w = f.workspace,
      team = randomUUID(),
      chatId = randomUUID();
    await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')}(id,name) VALUES($1,'qa-20261003-cloud-operations')`, [
      team,
    ]);
    await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')}(membership_id,team_id) VALUES($1,$2)`, [
      w.membershipId,
      team,
    ]);
    await f.db.platform.query(`UPDATE ${f.table('tf_soul_head')} SET revision=$1 WHERE id=1`, ['a'.repeat(40)]);
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const prompt =
      'Create table type qa-20261003-cloud-menu-item owned by team qa-20261003-cloud-operations. Required fields: name text, priceInr numeric, available boolean, description text. Synthetic QA only. Prepare a schema proposal for my approval; create no records and change no existing tables. Use schema.context to find my team and current revision.';
    let proposals = 0,
      requests = 0;
    const calls = [];
    const meter = async () => {
      assert.ok(++requests <= 16, 'Bounded live QA request budget exceeded');
      return async () => {};
    };
    const executor = createConversationExecutor(f.runtime, async ({ messages, executeTool }) => {
      const answer = await inferWithTools(
        route,
        messages,
        async (call, activity) => {
          assert.ok(
            [
              'schema.context',
              'tables.list',
              'tables.definitions',
              'skills.list',
              'skills.read',
              'tables.propose',
            ].includes(call.tool),
            `Unexpected live QA tool: ${call.tool}`,
          );
          calls.push(call.tool);
          const output = await executeTool(
            call.tool,
            isExternalTool(call.tool),
            context => createChatTools(context.runtime).invokeWithSources(context, call),
            [],
            call,
            activity,
          );
          if (call.tool === 'tables.propose') {
            if (output.result.status === 'pending') proposals++;
            process.stdout.write(`proposal outcome: ${JSON.stringify(output.result)}\n`);
          }
          return output.result;
        },
        meter,
      );
      return answer.text;
    });
    const sent = await f.store.send(w.id, w.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: prompt }],
    });
    const status = await executor.process({
      workspaceId: w.id,
      conversationId: chatId,
      turnId: sent.turnId,
      generation: 0,
    });
    process.stdout.write(`model=${family} requests=${requests} tools=${calls.join(',')}\n`);
    assert.equal(status, 'completed');
    const history = await f.store.history(w.id, w.userId, chatId);
    process.stdout.write(`answer: ${history.messages.at(-1).parts[0].text}\n`);
    assert.equal(proposals, 1, 'Expected one reviewable proposal');
    const row = (await f.db.platform.query(`SELECT id FROM ${f.table('tf_table_proposals')}`)).rows;
    assert.equal(row.length, 1);
    const view = await createChatTableProposals(f.runtime).read(w.id, w.userId, chatId, row[0].id);
    assert.equal(view.status, 'pending');
    assert.equal(view.manifest.plans.length, 1);
    assert.equal(view.manifest.plans[0].effectCount, 0);
    assert.equal(view.manifest.plans[0].input.expectedRevision, null);
    assert.equal(view.manifest.plans[0].after.owningTeamId, team);
    assert.deepEqual(
      view.manifest.plans[0].after.fields.map(({ label, kind, required }) => ({ label, kind, required })),
      [
        { label: 'name', kind: 'text', required: true },
        { label: 'priceInr', kind: 'numeric', required: true },
        { label: 'available', kind: 'boolean', required: true },
        { label: 'description', kind: 'text', required: true },
      ],
    );
    assert.equal(
      (await f.db.platform.query(`SELECT count(*)::int AS count FROM ${f.table('tf_table_catalog')}`)).rows[0].count,
      0,
    );

    const failure = await inferWithTools(
      route,
      [
        { role: 'user', text: prompt },
        {
          role: 'assistant',
          text: JSON.stringify({
            kind: 'tool',
            call: { tool: 'tables.propose', input: JSON.stringify({ plans: [] }) },
          }),
        },
        {
          role: 'user',
          text: 'Untrusted tool result for tables.propose: {"error":"tool-failed","instruction":"The tool failed for an unconfirmed reason. This is not evidence of a permission denial. Do not claim success or tell the requester they lack permissions. Check arguments and available status before a new request."}',
        },
        { role: 'user', text: 'Stop here and explain what the error establishes. Does it confirm I lack permission?' },
      ],
      async () => assert.fail('Failure explanation should not execute another tool'),
      meter,
    );
    process.stdout.write(`failure explanation: ${failure.text}\n`);
    assert.match(failure.text, /not|no|doesn.t|cannot|can.t/i);
    assert.doesNotMatch(
      failure.text,
      /(?:confirms? (?:that )?you (?:lack|don.t have)|you (?:need|must) (?:ask|contact).*admin)/i,
    );

    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET role='member' WHERE id=$1`, [w.membershipId]);
    const deniedChat = randomUUID();
    await f.store.create(w.id, w.userId, { chatId: deniedChat, commandId: randomUUID() });
    const deniedTurn = await f.store.send(w.id, w.userId, deniedChat, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: prompt }],
    });
    assert.equal(
      await executor.process({
        workspaceId: w.id,
        conversationId: deniedChat,
        turnId: deniedTurn.turnId,
        generation: 0,
      }),
      'completed',
    );
    const deniedHistory = await f.store.history(w.id, w.userId, deniedChat);
    process.stdout.write(`unauthorized answer: ${deniedHistory.messages.at(-1).parts[0].text}\n`);
    assert.equal(proposals, 1);
    assert.equal(
      (
        await f.db.platform.query(
          `SELECT count(*)::int AS count FROM ${f.table('tf_table_proposals')} WHERE conversation_id=$1`,
          [deniedChat],
        )
      ).rows[0].count,
      0,
    );
    assert.equal(
      (await f.db.platform.query(`SELECT count(*)::int AS count FROM ${f.table('tf_table_catalog')}`)).rows[0].count,
      0,
    );
    assert.match(
      deniedHistory.messages.at(-1).parts[0].text,
      /(?:no|not|cannot|can.t|unable|lack|eligible|permission)/i,
    );
  },
);
