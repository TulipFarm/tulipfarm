import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { savedTaskAgent } from '../../../packages/agents/test/task-fixture.mjs';
import { createAgentExecutor } from '../../../packages/agents/dist/executor.js';
import { createAgentTasks } from '../../../packages/agents/dist/tasks.js';
import { createTaskApprovals } from '../../../packages/agents/dist/task-approvals.js';
import { createGitHubTaskTools } from '../../../packages/agents/dist/github-tasks.js';
import { createGitHubReads } from '@tulipfarm/github/reads';
import { createGitHubBatches } from '@tulipfarm/github/batches';
import { createGitHubBatchDecision } from '@tulipfarm/github/batch-approval';
import { requireDraftSources } from '@tulipfarm/agents/draft-sources';
import { githubChatFixture } from './github-read-fixture.mjs';
import { githubFileFixture } from './github-file-fixture.mjs';
import { repositoryFixture, repositoryTarget, branchSha } from './github-repository-fixture.mjs';
import { githubReleaseFixture } from './github-release-fixture.mjs';
import { githubActionsFixture } from './github-actions-fixture.mjs';
import { githubDiscussionFixture } from './github-discussion-fixture.mjs';
import { githubProjectFixture } from './github-project-fixture.mjs';
import { fileTarget, forkOperation } from '../../../packages/github/test/file-provider-fixture.mjs';
import { releaseOperations } from '../../../packages/github/test/release-provider-fixture.mjs';
import { actionsOperations } from '../../../packages/github/test/actions-provider-fixture.mjs';
import { discussionOperations } from '../../../packages/github/test/discussion-provider-fixture.mjs';
import { projectOperations } from '../../../packages/github/test/project-provider-fixture.mjs';

async function taskFixture(f) {
  const actor = { kind: 'human', ...f.member };
  const agent = await savedTaskAgent(
    f.db,
    f.one,
    f.runtime,
    actor.userId,
    actor.membershipId,
    [],
    ['github.personal.account', 'github.personal.read', 'github.personal.propose', 'github.personal.download'],
  );
  const options = f.options ?? { runtime: f.runtime, accounts: f.service, requireSources: requireDraftSources };
  const executor = createAgentExecutor({
    runtime: f.runtime,
    github: runtime => createGitHubTaskTools({ ...options, runtime, accounts: f.makeService({ runtime }) }),
  });
  await executor.configure(
    f.one.id,
    { kind: 'human', userId: f.one.userId, membershipId: f.one.membershipId },
    { agentId: agent.agentId, version: 0, enabled: true, teamIds: [agent.teamId], limits: [] },
  );
  const tasks = createAgentTasks(f.runtime);
  const task = await tasks.start(f.one.id, actor.userId, {
    requestId: randomUUID(),
    agentId: agent.agentId,
    text: 'Read the private repository.',
    limits: { toolCalls: 100, credits: 100, activeMilliseconds: 600000 },
  });
  const run = await createTaskApprovals(f.runtime).bindRun(f.one.id, actor.userId, task.id, { generation: 0 });
  const reads = createGitHubReads(options),
    batches = createGitHubBatches(options);
  const decide = createGitHubBatchDecision({
    ...options,
    resolveConfirmationCredential: async () => f.db.login(f.one, 'confirmation'),
  });
  const accountId = f.accountId ?? (await f.connect(123));
  await tasks.pause(f.one.id, actor.userId, task.id, { expectedGeneration: 0 });
  await reads.select(f.one.id, actor.userId, { taskId: task.id }, { accountId, expectedVersion: 0 });
  assert.deepEqual(
    (await tasks.history(f.one.id, actor.userId, task.id)).messages.map(message => [message.sequence, message.text]),
    [[0, 'Read the private repository.']],
  );
  await f.db.platform.query(`UPDATE ${f.table('tf_agent_tasks')} SET status='pending' WHERE id=$1`, [task.id]);
  let sequence = 0;
  const queue = async call => {
    const callId = randomUUID();
    await executor.queueCall(f.one.id, actor, { runId: run.runId, callId, sequence: sequence++, call });
    return { workspaceId: f.one.id, runId: run.runId, callId };
  };
  return { actor, agent, tasks, task, run, reads, batches, decide, executor, queue, accountId };
}

const cases = [
  [
    'repository',
    repositoryFixture,
    {
      kind: 'repository.settings',
      ...repositoryTarget,
      description: 'Updated',
      private: true,
      hasIssues: true,
      hasWiki: false,
      defaultBranch: 'main',
    },
  ],
  ['branch', repositoryFixture, { kind: 'branch.create', ...repositoryTarget, branch: 'next', headSha: branchSha }],
  [
    'file',
    githubFileFixture,
    {
      kind: 'file.create',
      ...fileTarget,
      path: 'task.txt',
      content: 'task bytes\n',
      encoding: 'utf-8',
      message: 'Task file',
    },
  ],
  ['pull', githubFileFixture, { ...forkOperation, head: 'other' }],
  ['release', githubReleaseFixture, releaseOperations[0]],
  ['actions', githubActionsFixture, actionsOperations[0]],
  ['discussion', githubDiscussionFixture, discussionOperations[0]],
  ['project', githubProjectFixture, projectOperations[0]],
];
for (const [family, fixture, operation] of cases)
  test(`${family} task executor requires exact approval and retains one effect across replay`, async t => {
    const f = await fixture();
    t.after(() => f.close());
    const p = await taskFixture(f);
    const ids = await p.queue({ tool: 'github.personal.propose', actions: [operation] });
    assert.equal(await p.executor.execute(ids), 'waiting');
    const batch = (await p.batches.list(f.one.id, p.actor.userId, { taskId: p.task.id })).batches[0];
    assert.equal(batch.snapshot.origin.kind, 'task');
    assert.equal(batch.snapshot.actions[0].kind, operation.kind);
    assert.equal(batch.decision, null);
    assert.equal(f.effects.length, 0);
    await assert.rejects(
      p.decide(f.one.id, p.actor.userId, { taskId: p.task.id }, batch.snapshot.id, {
        digest: '0'.repeat(64),
        decision: 'approve',
      }),
    );
    assert.equal(await p.executor.execute(ids), 'waiting');
    assert.equal(f.effects.length, 0);
    await p.decide(f.one.id, p.actor.userId, { taskId: p.task.id }, batch.snapshot.id, {
      digest: batch.digest,
      decision: 'approve',
    });
    assert.equal(await p.executor.execute(ids), 'completed');
    const result = await p.executor.readResult(ids, p.actor);
    assert.equal(result.result.data.actions[0].status, 'succeeded');
    assert.equal(f.effects.length, 1);
    assert.equal(await p.executor.execute(ids), 'completed');
    assert.deepEqual(await p.executor.readResult(ids, p.actor), result);
    assert.equal(f.effects.length, 1);
  });

for (const retainedSource of [false, true])
  test(`clear and reselect never restores discarded task context, retained GitHub source ${retainedSource}`, async t => {
    const f = await githubChatFixture();
    t.after(() => f.close());
    f.setProvider(async () => Response.json({ id: 42, name: 'private' }));
    const p = await taskFixture(f);
    let sources = [];
    if (retainedSource) {
      const ids = await p.queue({
        tool: 'github.personal.read',
        operation: { kind: 'repository.read', owner: 'octocat', repo: 'private' },
      });
      assert.equal(await p.executor.execute(ids), 'completed');
      const result = (await p.executor.readResult(ids, p.actor)).result;
      assert.equal(result.data.data.name, 'private');
      sources = result.sources;
      assert.equal(sources[0].accountId, p.accountId);
    }
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_agent_task_messages')} (task_id,sequence,generation,role,text,sources) VALUES ($1,1,0,'agent','Private result from account A',$2)`,
      [p.task.id, JSON.stringify(sources)],
    );
    assert.equal(
      (await p.tasks.history(f.one.id, p.actor.userId, p.task.id)).messages.at(-1).text,
      'Private result from account A',
    );
    await p.tasks.pause(f.one.id, p.actor.userId, p.task.id, { expectedGeneration: 0 });
    const second = await f.connect(456);
    const resetText =
      'GitHub account selection changed. Earlier context and pending approvals cannot be reused. Describe what to do with this account.';
    for (const [accountId, expectedVersion, generation, cutoff] of [
      [null, 1, 1, 2],
      [null, 2, 1, 2],
      [second, 3, 1, 2],
      [null, 4, 2, 3],
      [p.accountId, 5, 2, 3],
    ]) {
      await p.reads.select(f.one.id, p.actor.userId, { taskId: p.task.id }, { accountId, expectedVersion });
      const history = await p.tasks.history(f.one.id, p.actor.userId, p.task.id);
      assert.deepEqual(
        history.messages.map(message => [message.sequence, message.text, message.sources]),
        [[cutoff, resetText, []]],
      );
      assert.equal((await p.tasks.read(f.one.id, p.actor.userId, p.task.id)).generation, generation);
    }
  });

test('revoking run authority blocks an already approved task effect', async t => {
  const f = await githubFileFixture();
  t.after(() => f.close());
  const p = await taskFixture(f);
  const ids = await p.queue({
    tool: 'github.personal.propose',
    actions: [
      {
        kind: 'file.create',
        ...fileTarget,
        path: 'revoked.txt',
        content: 'must not write',
        encoding: 'utf-8',
        message: 'Revoked',
      },
    ],
  });
  assert.equal(await p.executor.execute(ids), 'waiting');
  const batch = (await p.batches.list(f.one.id, p.actor.userId, { taskId: p.task.id })).batches[0];
  await p.decide(f.one.id, p.actor.userId, { taskId: p.task.id }, batch.snapshot.id, {
    digest: batch.digest,
    decision: 'approve',
  });
  await p.executor.configure(
    f.one.id,
    { kind: 'human', userId: f.one.userId, membershipId: f.one.membershipId },
    { agentId: p.agent.agentId, version: 1, enabled: false, teamIds: [p.agent.teamId], limits: [] },
  );
  assert.equal(await p.executor.execute(ids), 'blocked');
  assert.equal(f.effects.length, 0);
});
