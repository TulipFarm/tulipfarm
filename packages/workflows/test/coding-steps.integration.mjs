import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { createWorkflows } from '../src/service.ts';
import { activate } from './commands.fixture.mjs';

const definition = {
  version: 1,
  name: 'Fix an issue',
  triggers: [],
  steps: [
    {
      id: 'fix',
      kind: 'coding',
      agent: 'claude-code',
      repository: { kind: 'input', path: ['repository'] },
      prompt: { kind: 'input', path: ['task'] },
    },
    { id: 'report', kind: 'transform', fields: { link: { kind: 'step', step: 'fix', path: ['pullRequest', 'url'] } } },
  ],
};
const output = {
  status: 'changed',
  agent: 'claude-code',
  repository: 'octo/app',
  base: 'main',
  message: 'Fixed the bug.',
  files: ['a.txt'],
  diffTruncated: false,
  branch: 'tulipfarm/fix',
  pullRequest: { number: 7, url: 'https://github.com/octo/app/pull/7' },
};

test(
  'a coding step hands its job to the runner once and continues with the recorded result',
  { timeout: 60000 },
  async () => {
    const db = await fixture();
    let runtime;
    try {
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const w = await db.create(await workspaceTableMigrations());
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      await assert.rejects(
        createWorkflows(runtime).save(w.id, w.userId, randomUUID(), {
          revision: randomUUID(),
          expectedRevision: null,
          definition,
        }),
        { message: 'coding-steps-unavailable' },
      );

      const started = [];
      let refuse = true;
      const service = createWorkflows(runtime, {
        codingRuns: {
          start: async (...args) => {
            // The first hand-off is lost, so the step must try again rather than wait for a job that never began.
            if (refuse) {
              refuse = false;
              throw new Error('runner offline');
            }
            started.push(args);
          },
        },
      });
      const id = randomUUID(),
        revision = randomUUID();
      await service.save(w.id, w.userId, id, { revision, expectedRevision: null, definition });
      await activate(service, w.id, w.userId, id, revision, true);
      const run = async input => {
        const { runId } = await service.start(w.id, w.userId, id, { requestId: randomUUID(), input });
        return { workspaceId: w.id, runId };
      };
      const latest = async runId =>
        (await service.history(w.id, w.userId, id).then(page => page.runs)).find(item => item.id === runId);

      const work = await run({ repository: 'octo/app', task: 'Fix the login bug' });
      assert.deepEqual(await service.activity(work), { kind: 'wait', seconds: 5 });
      assert.equal(started.length, 0);
      assert.deepEqual(await service.activity(work), { kind: 'wait', seconds: 30 });
      assert.equal(started.length, 1);
      const [, runId, stepId, jobId] = started[0];
      assert.equal(runId, work.runId);
      assert.equal(stepId, 'fix');
      assert.deepEqual(
        await service.activity(work),
        { kind: 'wait', seconds: 30 },
        'a running job is not started again',
      );
      assert.equal(started.length, 1);
      assert.equal((await latest(work.runId)).status, 'waiting');

      const job = await service.codingJob(w.id, work.runId, 'fix', jobId);
      assert.equal(job.userId, w.userId, 'a run started by hand uses the plan of the person who started it');
      assert.deepEqual(job.job, {
        agent: 'claude-code',
        repository: 'octo/app',
        branch: null,
        prompt: 'Fix the login bug',
        pullRequest: true,
        title: null,
      });
      assert.equal(await service.codingJob(w.id, work.runId, 'fix', randomUUID()), null);

      assert.equal(
        await service.recordCodingResult(w.id, work.runId, 'fix', jobId, { kind: 'completed', output }),
        true,
      );
      assert.equal(
        await service.recordCodingResult(w.id, work.runId, 'fix', jobId, { kind: 'failed', error: 'interrupted' }),
        false,
        'a result is recorded only once',
      );
      assert.equal(await service.codingJob(w.id, work.runId, 'fix', jobId), null);
      for (let i = 0; i < 5 && (await latest(work.runId)).status !== 'completed'; i++) await service.activity(work);
      const completed = await latest(work.runId);
      assert.equal(completed.status, 'completed');
      assert.deepEqual(
        completed.steps.map(step => step.output),
        [output, { link: 'https://github.com/octo/app/pull/7' }],
      );

      const failing = await run({ repository: 'octo/app', task: 'Fix it' });
      await service.activity(failing);
      const failedJob = started.at(-1)[3];
      await service.recordCodingResult(w.id, failing.runId, 'fix', failedJob, {
        kind: 'failed',
        error: 'plan-required',
        message: 'Connect a Claude plan.',
      });
      await service.activity(failing);
      assert.equal((await latest(failing.runId)).error, 'coding-plan-required');

      const invalid = await run({ repository: 'not a repository', task: 'Fix it' });
      await service.activity(invalid);
      assert.equal((await latest(invalid.runId)).error, 'coding-input-invalid');
      assert.equal(started.length, 2, 'an invalid job never reaches the runner');
    } finally {
      await runtime?.close();
      await db.close();
    }
  },
);
