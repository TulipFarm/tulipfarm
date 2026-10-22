import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { createWorkflows } from '../src/service.ts';
import { activate } from './commands.fixture.mjs';

test(
  'condition steps choose a branch, skip the other, and run history records which branch ran',
  { timeout: 120000 },
  async t => {
    const db = await fixture();
    const cleanup = [];
    t.after(async () => {
      for (const close of cleanup.reverse()) await close();
      await db.close();
    });
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const w = await db.create(await workspaceTableMigrations());
    const runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
    });
    cleanup.push(() => runtime.close());
    const service = createWorkflows(runtime);
    const input = path => ({ kind: 'input', path });
    const literal = value => ({ kind: 'literal', value });
    const note = (id, text) => ({ id, kind: 'transform', fields: { note: literal(text) } });
    const definition = {
      version: 1,
      name: 'Route order',
      trigger: { kind: 'manual' },
      steps: [
        {
          id: 'large',
          kind: 'condition',
          when: { left: input(['values', 'amount']), op: 'gte', right: literal(1000) },
          ifMet: ['approve', 'rush', 'notify_finance'],
          otherwise: ['file_order'],
        },
        { id: 'approve', kind: 'human', prompt: 'Approve this large order?', timeoutSeconds: 60 },
        {
          id: 'rush',
          kind: 'condition',
          when: { left: input(['rush']), op: 'eq', right: literal(true) },
          ifMet: ['call_customer'],
          otherwise: [],
        },
        {
          id: 'call_customer',
          kind: 'transform',
          fields: { decision: { kind: 'step', step: 'approve', path: ['approved'] } },
        },
        {
          id: 'notify_finance',
          kind: 'transform',
          fields: { decision: { kind: 'step', step: 'approve', path: ['approved'] } },
        },
        note('file_order', 'Filed'),
        note('done', 'Recorded'),
      ],
    };
    const id = randomUUID(),
      revision = randomUUID();
    await service.save(w.id, w.userId, id, { revision, expectedRevision: null, definition });
    await activate(service, w.id, w.userId, id, revision, true);
    const start = async value =>
      (await service.start(w.id, w.userId, id, { requestId: randomUUID(), input: value })).runId;
    const drive = async runId => {
      for (let step = 0; step < 20; step++) {
        const progress = await service.advance({ workspaceId: w.id, runId });
        if (progress.kind !== 'continue') return progress;
      }
      assert.fail('run did not settle');
    };
    const run = async runId =>
      (await service.history(w.id, w.userId, id).then(page => page.runs)).find(item => item.id === runId);
    const taken = run => run.steps.map(step => [step.stepId, step.ordinal, step.status]);

    const small = await start({ values: { amount: { kind: 'numeric', value: '250.00' } }, rush: true });
    assert.deepEqual(await drive(small), { kind: 'done' });
    const smallRun = await run(small);
    assert.equal(smallRun.status, 'completed');
    assert.deepEqual(
      taken(smallRun),
      [
        ['large', 0, 'completed'],
        ['file_order', 5, 'completed'],
        ['done', 6, 'completed'],
      ],
      'the otherwise branch ran, the ifMet branch and its nested condition left no receipts, and the unlisted step ran',
    );
    assert.deepEqual(
      smallRun.steps[0].output,
      { matched: false, ran: ['file_order'], skipped: ['approve', 'rush', 'notify_finance'] },
      'a typed numeric table value compares as a number',
    );

    const big = await start({ values: { amount: { kind: 'numeric', value: '1250.50' } }, rush: false });
    assert.deepEqual(await drive(big), { kind: 'wait', seconds: 60 }, 'the ifMet branch waits on its human step');
    await service.respond(w.id, w.userId, id, big, {
      stepId: 'approve',
      responseId: randomUUID(),
      output: { approved: true },
    });
    assert.deepEqual(await drive(big), { kind: 'done' });
    const bigRun = await run(big);
    assert.equal(bigRun.status, 'completed');
    assert.deepEqual(taken(bigRun), [
      ['large', 0, 'completed'],
      ['approve', 1, 'completed'],
      ['rush', 2, 'completed'],
      ['notify_finance', 4, 'completed'],
      ['done', 6, 'completed'],
    ]);
    assert.deepEqual(
      bigRun.steps.find(step => step.stepId === 'rush').output,
      { matched: false, ran: [], skipped: ['call_customer'] },
      'a condition with an empty otherwise branch skips its ifMet steps',
    );
    assert.deepEqual(bigRun.steps.find(step => step.stepId === 'notify_finance').output, { decision: true });

    const unknown = await start({ values: {}, rush: false });
    assert.deepEqual(await drive(unknown), { kind: 'done' });
    const unknownRun = await run(unknown);
    assert.equal(
      unknownRun.status,
      'failed',
      'a missing amount cannot be ordered against a number, so the run fails instead of guessing a branch',
    );
    assert.equal(unknownRun.error, 'condition-values-incomparable');
    assert.deepEqual(taken(unknownRun), []);

    await assert.rejects(
      service.save(w.id, w.userId, randomUUID(), {
        revision: randomUUID(),
        expectedRevision: null,
        definition: {
          ...definition,
          steps: [
            ...definition.steps,
            { id: 'late', kind: 'transform', fields: { decision: { kind: 'step', step: 'approve', path: [] } } },
          ],
        },
      }),
      /runs whenever this step runs/,
      'an unconditional step cannot read a branch step that may be skipped',
    );
  },
);
