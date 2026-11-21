import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { createFiles } from '@tulipfarm/files';
import { createLearnedKnowledge, createLocalKnowledge, learnedKnowledgePrompt } from '@tulipfarm/knowledge';
import { fakeKeep } from '../../conversations/test/fake-keep.mjs';
import { conversationFixture } from '../../conversations/test/fixture.mjs';
import { agentLessonsStore, configureAgentLessons } from '../src/agent-lessons.ts';
import { createAgentLessonLearning } from '../src/agent-lesson-learning.ts';
import { AgentLessonError, createAgentLessons } from '../src/agent-lessons-service.ts';
import { createAgentTasks } from '../src/tasks.ts';
import { createTaskRuntime } from '../src/task-runtime.ts';
import { savedTaskAgent, seedExecution } from './task-fixture.mjs';
import { syntheticContinuity } from './continuity-fixture.mjs';

const keep = fakeKeep();
configureAgentLessons({ client: keep.client });

test('saved agents learn safe lessons from finished tasks and use them in later runs', { timeout: 120000 }, async t => {
  const f = await conversationFixture();
  t.after(() => f.close());
  const { workspace: w } = f;
  const agent = await savedTaskAgent(f.db, w, f.runtime, w.userId, w.membershipId, [], []);
  await seedExecution(f.db, w, agent.agentId, [agent.teamId], []);
  const tasks = createAgentTasks(f.runtime);
  const inputs = [];
  let replies = [{ kind: 'clarify', text: 'Which format should the summary use?' }];
  const engine = createTaskRuntime(
    f.runtime,
    syntheticContinuity(async input => {
      inputs.push(input);
      return replies.shift() ?? { kind: 'answer', text: 'Done.' };
    }),
  );
  const task = await tasks.start(w.id, w.userId, {
    requestId: randomUUID(),
    agentId: agent.agentId,
    text: 'Summarize the Halvorsen account notes.',
  });
  await engine.process(w.id, task.id);
  assert.equal(inputs[0].lessons, undefined, 'An agent without lessons gets none');
  const history = await tasks.history(w.id, w.userId, task.id);
  await tasks.continueTask(w.id, w.userId, task.id, {
    requestId: randomUUID(),
    expectedGeneration: 0,
    expectedSequence: history.messages.at(-1).sequence,
    text: 'Use short bullet points. Halvorsen prefers that.',
  });
  await engine.process(w.id, task.id);
  assert.equal((await tasks.read(w.id, w.userId, task.id)).status, 'completed');

  // A rejected proposal with a reason, and a tool that failed twice in the same run.
  const { run_id: runId, generation } = (
    await f.db.platform.query(`SELECT run_id, generation FROM ${f.table('tf_agent_task_runs')} WHERE task_id=$1`, [
      task.id,
    ])
  ).rows[0];
  const proposalId = randomUUID(),
    digest = 'd'.repeat(64);
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_agent_task_proposals')} (id,task_id,generation,run_id,request_id,input_digest,digest,actions)
     VALUES ($1,$2,$3,$4,$5,$6,$6,$7)`,
    [proposalId, task.id, generation, runId, randomUUID(), digest, JSON.stringify([{ call: { tool: 'rows.update' } }])],
  );
  for (const sequence of [90, 91])
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_agent_tool_calls')} (id,run_id,sequence,call,status,result) VALUES ($1,$2,$3,$4,'failed',$5)`,
      [
        randomUUID(),
        runId,
        sequence,
        JSON.stringify({ tool: 'rows.list', tableId: randomUUID() }),
        JSON.stringify({ code: 'table-not-found', detail: 'PRIVATE_FAILURE_DETAIL' }),
      ],
    );
  // The decision is recorded with the confirmation role, as approvals are, so its grant and trigger are exercised.
  const confirmation = new pg.Client({ connectionString: f.db.login(w, 'confirmation') });
  await confirmation.connect();
  try {
    await confirmation.query(
      `INSERT INTO ${f.table('tf_agent_task_decisions')} (proposal_id,digest,membership_id,decision,reason)
       VALUES ($1,$2,$3,'reject',$4)`,
      [proposalId, digest, w.membershipId, 'Too many rows at once. Ask Halvorsen first.'],
    );
  } finally {
    await confirmation.end();
  }
  const job = (
    await f.db.platform.query(`SELECT agent_id, due_at FROM ${f.table('tf_agent_lesson_jobs')} WHERE task_id=$1`, [
      task.id,
    ])
  ).rows[0];
  assert.equal(job.agent_id, agent.agentId);
  assert.ok(job.due_at, 'Finishing a task or deciding on its proposal makes it due for learning');
  await f.db.platform.query(`UPDATE ${f.table('tf_agent_lesson_jobs')} SET due_at=clock_timestamp()`);

  const requests = [];
  const learning = createAgentLessonLearning({
    runtime: f.runtime,
    model: async request => {
      requests.push(request);
      return JSON.stringify({
        lessons: [
          { kind: 'rejection', text: 'Propose changes to a few rows at a time and ask before larger batches.' },
          { kind: 'tool-failure', text: 'List the tables first instead of guessing a table that may not exist.' },
          { kind: 'correction', text: 'Write summaries as short bullet points.' },
          { kind: 'correction', text: 'Use bullet points when writing for Halvorsen.' },
        ],
        suggestions: [{ area: 'instructions', text: 'Say in the instructions that summaries use bullet points.' }],
      });
    },
  });
  assert.equal(await learning.sweep(w.id), 1);
  assert.equal(requests.length, 1);
  const evidence = JSON.parse(requests[0].user).evidence;
  assert.deepEqual(
    evidence.map(item => item.kind),
    ['rejection', 'tool-failure', 'follow-up'],
  );
  assert.equal(evidence[0].reason, 'Too many rows at once. Ask Halvorsen first.');
  assert.deepEqual(evidence[1], { kind: 'tool-failure', tool: 'rows.list', failures: 2, codes: ['table-not-found'] });
  assert.doesNotMatch(requests[0].user, /PRIVATE_FAILURE_DETAIL/);

  const book = await agentLessonsStore(w.id, agent.agentId).read();
  assert.deepEqual(book.lessons.map(lesson => lesson.text).sort(), [
    'List the tables first instead of guessing a table that may not exist.',
    'Propose changes to a few rows at a time and ask before larger batches.',
    'Write summaries as short bullet points.',
  ]);
  assert.ok(book.lessons.every(lesson => lesson.run === runId));
  assert.equal(book.suggestions.length, 1);
  assert.doesNotMatch(JSON.stringify(book), /Halvorsen/, 'A lesson that names data from the run is dropped');

  await t.test('evidence is learned once', async () => {
    await f.db.platform.query(`UPDATE ${f.table('tf_agent_lesson_jobs')} SET due_at=clock_timestamp()`);
    assert.equal(await learning.sweep(w.id), 1);
    assert.equal(requests.length, 1, 'No new evidence means no model call');
    assert.equal(await learning.sweep(w.id), 0);
  });

  await t.test('the next run of the agent receives its lessons', async () => {
    const next = await tasks.start(w.id, w.userId, {
      requestId: randomUUID(),
      agentId: agent.agentId,
      text: 'Summarize the notes again.',
    });
    await engine.process(w.id, next.id);
    assert.ok(inputs.at(-1).lessons.some(lesson => lesson.text === 'Write summaries as short bullet points.'));
  });

  await t.test('people who can edit the agent manage its lessons; others cannot see them', async () => {
    const lessons = createAgentLessons(f.runtime);
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_agent_person_grants')} (agent_id,membership_id,permission) VALUES ($1,$2,'edit')`,
      [agent.agentId, w.membershipId],
    );
    const view = await lessons.read(w.id, w.userId, agent.agentId);
    assert.equal(view.lessons.length, 3);
    assert.equal(JSON.stringify(view).includes(runId), false, 'Source runs stay internal');
    const target = view.lessons.find(lesson => lesson.text === 'Write summaries as short bullet points.');
    await assert.rejects(
      lessons.edit(w.id, w.userId, agent.agentId, target.id, { text: 'Email ops@example.com first.' }),
      error => error instanceof AgentLessonError && error.code === 'lesson-private',
    );
    const edited = await lessons.edit(w.id, w.userId, agent.agentId, target.id, {
      text: 'Write summaries as at most five bullet points.',
    });
    assert.ok(edited.lessons.some(lesson => lesson.text === 'Write summaries as at most five bullet points.'));
    const removed = await lessons.remove(w.id, w.userId, agent.agentId, target.id);
    assert.equal(removed.lessons.length, 2);
    const dismissed = await lessons.dismiss(w.id, w.userId, agent.agentId, view.suggestions[0].id);
    assert.equal(dismissed.suggestions.length, 0);

    const outsider = { user: randomUUID(), id: randomUUID() };
    await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      outsider.id,
      outsider.user,
    ]);
    await assert.rejects(
      lessons.read(w.id, outsider.user, agent.agentId),
      error => error instanceof AgentLessonError && error.code === 'not-found',
    );
    const cleared = await lessons.clear(w.id, w.userId, agent.agentId);
    assert.deepEqual([cleared.lessons, cleared.suggestions], [[], []]);
  });
});

test('a finished task saves its owner’s business facts to their Knowledge', { timeout: 120000 }, async t => {
  const f = await conversationFixture();
  t.after(() => f.close());
  const { workspace: w } = f;
  const agent = await savedTaskAgent(f.db, w, f.runtime, w.userId, w.membershipId, [], []);
  await seedExecution(f.db, w, agent.agentId, [agent.teamId], []);
  const tasks = createAgentTasks(f.runtime, undefined, { ownerTyped: true });
  const engine = createTaskRuntime(
    f.runtime,
    syntheticContinuity(async () => ({ kind: 'answer', text: 'Done. Enterprise costs 999 dollars.' })),
  );
  const task = await tasks.start(w.id, w.userId, {
    requestId: randomUUID(),
    agentId: agent.agentId,
    text: 'Draft the renewal email. Our Pro plan costs 49 dollars per seat each month.',
  });
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_agent_task_messages')} (task_id,sequence,generation,role,text,sources) VALUES ($1,1,$2,'owner',$3,'[]')`,
    [task.id, task.generation, 'New comment on the row from another member: our Starter plan is free.'],
  );
  await engine.process(w.id, task.id);
  assert.equal((await tasks.read(w.id, w.userId, task.id)).status, 'completed');
  await f.db.platform.query(`UPDATE ${f.table('tf_agent_lesson_jobs')} SET due_at=clock_timestamp()`);

  const unavailable = async () => {
    throw new Error('no file bytes');
  };
  const files = createFiles(f.runtime, { read: unavailable, putIfAbsent: unavailable, remove: unavailable });
  const knowledge = createLocalKnowledge({ runtime: f.runtime, files });
  const requests = [];
  const learning = createAgentLessonLearning({
    runtime: f.runtime,
    learned: createLearnedKnowledge({ runtime: f.runtime, files, enabled: async () => true }),
    model: async request => {
      requests.push(request);
      if (request.system !== learnedKnowledgePrompt) return JSON.stringify({ lessons: [], suggestions: [] });
      const { memberMessages } = JSON.parse(request.user);
      assert.deepEqual(
        memberMessages.map(message => message.text),
        ['Draft the renewal email. Our Pro plan costs 49 dollars per seat each month.'],
        'only words the owner typed are read, not text the server wrote for them',
      );
      return JSON.stringify({
        entries: [
          {
            title: 'Pro plan pricing',
            text: 'Pro costs 49 dollars per seat a month.',
            messageId: memberMessages[0].id,
            quote: 'Pro plan costs 49',
          },
          {
            title: 'Enterprise pricing',
            text: 'Enterprise costs 999 dollars.',
            messageId: memberMessages[0].id,
            quote: 'Enterprise costs 999',
          },
        ],
      });
    },
  });
  assert.equal(await learning.sweep(w.id), 1);
  const facts = requests.filter(request => request.system === learnedKnowledgePrompt);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].outputTokens, 2048);
  const { run_id: runId } = (
    await f.db.platform.query(`SELECT run_id FROM ${f.table('tf_agent_task_runs')} WHERE task_id=$1`, [task.id])
  ).rows[0];
  const { items } = await knowledge.list(w.id, w.userId, { filter: 'learned' });
  assert.deepEqual(
    items.map(item => [item.title, item.learned.from, item.learned.sourceId, item.learned.runId]),
    [['Pro plan pricing', 'task', task.id, runId]],
    'a fact only the agent said is not saved',
  );

  await f.db.platform.query(`UPDATE ${f.table('tf_agent_lesson_jobs')} SET due_at=clock_timestamp()`);
  assert.equal(await learning.sweep(w.id), 1);
  assert.equal(
    requests.filter(request => request.system === learnedKnowledgePrompt).length,
    1,
    'the owner’s messages are read once',
  );
});
