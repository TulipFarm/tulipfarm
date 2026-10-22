import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createChatTools } from '../src/tools.ts';

test(
  "chat plan tools create, read, and update only this chat's plan and wake its scheduler",
  { timeout: 120000 },
  async t => {
    const db = await fixture();
    let runtime;
    t.after(async () => {
      await runtime?.close();
      await db.close();
    });
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const w = await db.create(await workspaceTableMigrations());
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async () => ({ workspaceId: w.id, generation: 1, connectionString: db.login(w) }),
    });
    const table = name => `"${w.names.schema}".${name}`;
    const [user, stranger, member, strangerMember] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await db.platform.query(
      `INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member'),($3,$4,'member')`,
      [member, user, strangerMember, stranger],
    );
    const [chat, otherChat, strangerChat] = [randomUUID(), randomUUID(), randomUUID()];
    await db.platform.query(
      `INSERT INTO ${table('tf_conversations')} (id,owner_user_id,owner_membership_id) VALUES ($1,$3,$4),($2,$3,$4),($5,$6,$7)`,
      [chat, otherChat, user, member, strangerChat, stranger, strangerMember],
    );
    const turn = async conversationId => {
      const [message, id] = [randomUUID(), randomUUID()];
      await db.platform.query(
        `INSERT INTO ${table('tf_conversation_messages')} (id,conversation_id,sequence,author_kind,membership_id) VALUES ($1,$2,1,'human',$3)`,
        [message, conversationId, member],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_conversation_turns')} (id,conversation_id,source_message_id,accepted_sequence) VALUES ($1,$2,$3,1)`,
        [id, conversationId, message],
      );
      return id;
    };
    const turns = { [chat]: await turn(chat), [otherChat]: await turn(otherChat) };
    const wakes = [];
    const tools = createChatTools(runtime, {
      telemetryRuntime: 'chat',
      wakePlan: async (workspaceId, planId) => {
        wakes.push([workspaceId, planId]);
      },
    });
    const actor = { kind: 'human', userId: user, membershipId: member };
    const call = (conversationId, input) =>
      tools.invokeWithSources(
        {
          workspaceId: w.id,
          actor,
          callId: randomUUID(),
          origin: { conversationId, turnId: turns[conversationId], sources: [] },
        },
        input,
      );
    const chatSource = { kind: 'private-conversation', conversationId: chat };

    assert.deepEqual((await call(chat, { tool: 'plans.read' })).result.plan, null);
    await assert.rejects(
      tools.invokeWithSources({ workspaceId: w.id, actor, callId: randomUUID() }, { tool: 'plans.read' }),
      AccessDenied,
    );

    const outline = {
      tool: 'plans.create',
      title: 'Research a waitlist',
      brief: 'Compare waitlist approaches.',
      specialists: [
        {
          key: 'researcher',
          name: 'Researcher',
          role: 'Finds public examples',
          instructions: 'Search and summarize.',
          tools: ['web.search'],
        },
      ],
      tasks: [
        { key: 'research', kind: 'group', title: 'Research' },
        {
          key: 'examples',
          parent: 'research',
          title: 'Find examples',
          assignee: { kind: 'specialist', specialist: 'researcher' },
        },
        {
          key: 'pricing',
          parent: 'research',
          title: 'Find pricing',
          assignee: { kind: 'specialist', specialist: 'researcher' },
        },
        { key: 'summary', title: 'Summarize', dependsOn: ['research'], criteria: ['Names three approaches'] },
      ],
    };
    const created = await call(chat, outline);
    assert.deepEqual(created.sources, [chatSource]);
    assert.deepEqual(created.result, {
      planId: created.result.planId,
      version: 0,
      added: ['research', 'examples', 'pricing', 'summary'],
    });
    assert.deepEqual(wakes, [[w.id, created.result.planId]]);
    const planId = created.result.planId;

    assert.equal((await call(chat, outline)).result.error, 'plan-open');
    const cycle = await call(otherChat, {
      ...outline,
      specialists: [],
      tasks: [
        { key: 'a', title: 'A', dependsOn: ['b'] },
        { key: 'b', title: 'B', dependsOn: ['a'] },
      ],
    });
    assert.equal(cycle.result.error, 'dependency-cycle');
    assert.match(cycle.result.instruction, /^Nothing changed\. /);
    assert.equal(wakes.length, 1);

    const updated = await call(chat, {
      tool: 'plans.update',
      planId,
      expectedVersion: 0,
      mutations: [{ op: 'add', task: { key: 'review', title: 'Review', dependsOn: ['summary'] } }],
    });
    assert.deepEqual(updated.result, { planId, version: 1, added: ['review'] });
    assert.deepEqual(wakes.at(-1), [w.id, planId]);
    assert.equal(
      (
        await call(chat, {
          tool: 'plans.update',
          planId,
          expectedVersion: 0,
          mutations: [{ op: 'cancel', key: 'review', reason: 'Not needed' }],
        })
      ).result.error,
      'version-conflict',
    );

    await assert.rejects(call(otherChat, { tool: 'plans.read', planId }), AccessDenied);
    await assert.rejects(
      call(otherChat, {
        tool: 'plans.update',
        planId,
        expectedVersion: 1,
        mutations: [{ op: 'cancel', key: 'review', reason: 'Not needed' }],
      }),
      AccessDenied,
    );
    await assert.rejects(call(strangerChat, { tool: 'plans.read' }), AccessDenied);

    for (const [key, result, sources] of [
      ['examples', 'Three examples.', [chatSource]],
      ['pricing', 'Private pricing.', [{ kind: 'private-conversation', conversationId: strangerChat }]],
    ]) {
      await db.platform.query(
        `INSERT INTO ${table('tf_agent_plan_attempts')} (id,plan_id,task_key,generation,specialist_key,status,result,sources,settled_at) VALUES ($1,$2,$3,0,'researcher','completed',$4,$5,clock_timestamp())`,
        [randomUUID(), planId, key, result, JSON.stringify(sources)],
      );
    }
    const read = await call(chat, { tool: 'plans.read' });
    assert.equal(read.result.plan.id, planId);
    assert.equal(read.result.plan.version, 1);
    assert.deepEqual(read.result.results, [{ key: 'examples', result: 'Three examples.' }]);
    assert.deepEqual(read.result.withheld, ['pricing']);
    assert.deepEqual(read.sources, [chatSource, chatSource]);
  },
);
