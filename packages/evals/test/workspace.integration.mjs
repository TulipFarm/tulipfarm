// Workspace Evals against a real workspace database, with the model provider faked at the HTTP boundary.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { savedTaskAgent } from '../../agents/test/task-fixture.mjs';
import { modelEnvironment } from '../../agents/src/model-environment.ts';
import { catalogEligibility, createWorkspaceEvals, WorkspaceEvalError } from '../src/workspace.ts';

process.env.ANTHROPIC_API_KEY ??= 'test-placeholder';

const judgeMarker = 'Answer with one JSON object and nothing else';
const reply = 'Hello from the agent.';

/** Answers every provider request: judge prompts with a passing verdict, everything else with `reply`. */
function fakeProvider(t) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(String(options.body));
    requests.push(body);
    const judge = JSON.stringify(body).includes(judgeMarker);
    const text = judge ? '{"pass": true, "reason": "The reply greets the person."}' : reply;
    return new Response(
      JSON.stringify({
        id: `msg_${randomUUID()}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 20 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  return requests;
}

const rejects = (promise, code) =>
  assert.rejects(promise, error => error instanceof WorkspaceEvalError && error.code === code);

test(
  'workspace evals keep cases per agent, run them with metered credits and leave workspace data unchanged',
  {
    timeout: 120000,
  },
  async t => {
    const db = await fixture();
    let runtime;
    t.after(async () => {
      await runtime?.close();
      await db.close();
    });
    const w = await db.create(await workspaceTableMigrations());
    const table = name => `"${w.names.schema}".${name}`;
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async workspaceId => ({ workspaceId, generation: 1, connectionString: db.login(w) }),
    });
    const member = randomUUID(),
      memberUser = randomUUID();
    await db.platform.query(`INSERT INTO ${table('tf_memberships')}(id,user_id,role) VALUES($1,$2,'member')`, [
      member,
      memberUser,
    ]);
    const agent = await savedTaskAgent(db, w, runtime, memberUser, member, [], ['tables.list']);
    // Whoever creates an agent receives every permission on it; the fixture grants only management.
    await db.platform.query(
      `INSERT INTO ${table('tf_agent_person_grants')}(agent_id,membership_id,permission) VALUES($1,$2,'edit')`,
      [agent.agentId, w.membershipId],
    );
    const environment = modelEnvironment();
    const evals = createWorkspaceEvals({ runtime, environment, eligible: catalogEligibility(environment) });
    const editor = w.userId;

    const greeting = {
      name: 'Greets the person',
      message: 'Say hello.',
      checks: [
        { kind: 'text-contains', text: 'Hello' },
        { kind: 'judge', rubric: 'The reply greets the person.' },
      ],
    };
    const created = await evals.createCase(w.id, editor, agent.agentId, greeting);
    await evals.createCase(w.id, editor, agent.agentId, {
      name: 'Never lists tables',
      message: 'Say hello again.',
      checks: [{ kind: 'tool-not-called', tool: 'tables.list' }],
    });

    // A member who can only use the agent sees its cases but cannot change or run them.
    const seen = await evals.read(w.id, memberUser, agent.agentId);
    assert.equal(seen.canEdit, false);
    assert.deepEqual(
      seen.cases.map(item => item.name),
      ['Greets the person', 'Never lists tables'],
    );
    await rejects(evals.createCase(w.id, memberUser, agent.agentId, greeting), 'not-found');
    await rejects(evals.start(w.id, memberUser, agent.agentId, {}), 'not-found');
    await rejects(evals.read(w.id, editor, randomUUID()), 'not-found');

    const updated = await evals.updateCase(w.id, editor, agent.agentId, created.id, {
      ...greeting,
      name: 'Greets warmly',
    });
    assert.equal(updated.name, 'Greets warmly');

    const estimate = await evals.estimate(w.id, editor, agent.agentId, { repeats: 3 });
    assert.equal(estimate.replies, 6);
    assert.ok(estimate.credits > 0);
    await rejects(evals.estimate(w.id, editor, agent.agentId, { models: ['no-such-model'] }), 'model-unavailable');

    const run = await evals.start(w.id, editor, agent.agentId, {});
    assert.equal(run.status, 'queued');
    await rejects(evals.start(w.id, editor, agent.agentId, {}), 'run-active');
    assert.deepEqual(await evals.pending(w.id), [run.id]);

    const counts = async () =>
      (
        await db.platform.query(
          `SELECT (SELECT count(*) FROM ${table('tf_conversations')})::int AS conversations,
                (SELECT count(*) FROM ${table('tf_agent_tasks')})::int AS tasks,
                (SELECT count(*) FROM ${table('tf_conversation_messages')})::int AS messages,
                (SELECT count(*) FROM ${table('tf_agent_task_runs')})::int AS runs`,
        )
      ).rows[0];
    const before = await counts();
    const requests = fakeProvider(t);
    const tools = {
      invoke: async () => assert.fail('No case reads live data'),
    };
    await evals.execute(w.id, run.id, tools);
    assert.deepEqual(await counts(), before, 'a run writes nothing outside the eval tables');
    assert.ok(requests.length >= 3, 'two replies and one judge grade');

    const finished = await evals.run(w.id, memberUser, agent.agentId, run.id);
    assert.equal(finished.status, 'completed');
    assert.equal(finished.results.length, 2);
    assert.ok(finished.results.every(result => result.pass));
    assert.equal(finished.summary[0].passed, 2);
    assert.equal(finished.agentChanged, false);
    assert.ok(finished.judgeCredits > 0, 'the judge is billed separately');
    const usage = (
      await db.platform.query(`SELECT activity, charged FROM ${table('tf_credit_usage')} WHERE flow_id=$1`, [
        `agent-eval:${run.id}`,
      ])
    ).rows;
    assert.ok(usage.some(row => row.activity === 'agent'));
    assert.ok(usage.some(row => row.activity === 'other'));
    assert.ok(
      usage.every(row => row.charged !== null),
      'every reservation is settled',
    );
    await rejects(evals.cancel(w.id, editor, agent.agentId, run.id), 'run-finished');

    // Saving the agent marks older runs, and a run queued before the change fails instead of testing the new agent.
    const stale = await evals.start(w.id, editor, agent.agentId, {});
    await agent.activate();
    assert.equal((await evals.runs(w.id, editor, agent.agentId)).find(item => item.id === run.id).agentChanged, true);
    await evals.execute(w.id, stale.id, tools);
    const failed = await evals.run(w.id, editor, agent.agentId, stale.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.stopReason, 'agent-changed');

    // A cancelled run is never picked up.
    const cancelled = await evals.start(w.id, editor, agent.agentId, {});
    assert.equal((await evals.cancel(w.id, editor, agent.agentId, cancelled.id)).status, 'stopped');
    assert.deepEqual(await evals.pending(w.id), []);
    await evals.execute(w.id, cancelled.id, tools);
    assert.equal((await evals.run(w.id, editor, agent.agentId, cancelled.id)).status, 'stopped');

    await evals.deleteCase(w.id, editor, agent.agentId, created.id);
    assert.equal((await evals.read(w.id, editor, agent.agentId)).cases.length, 1);
  },
);
