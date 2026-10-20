import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchGitHubWrite, reconcileGitHubWrite, requireWriteTarget } from '../dist/write-provider.js';
import { githubBatchInputSchema } from '../dist/batch-contracts.js';
import { actionsProviderFixture, actionsOperations } from './actions-provider-fixture.mjs';

const credential = {
  accessToken: 'synthetic-actions-credential',
  identity: { id: '123', login: 'octocat' },
  scopes: ['repo'],
};
const send = (f, operation) =>
  dispatchGitHubWrite({ operation, credential, bindings: [], fetcher: f.fetcher, authorize: async () => true });
for (const operation of actionsOperations)
  test(`HTTP ${operation.kind} ${operation.mode ?? ''} persists a minimal acknowledgement with exact request`, async t => {
    const f = await actionsProviderFixture();
    t.after(f.close);
    await requireWriteTarget(operation, credential, f.fetcher, true);
    const outcome = await send(f, githubBatchInputSchema.parse({ actions: [operation] }).actions[0]);
    assert.equal(outcome.status, 'succeeded');
    assert.equal(outcome.result.repositoryId, 42);
    assert.equal(f.effects[0].version, '2026-03-10');
    if (operation.kind === 'actions.dispatch') {
      assert.deepEqual(f.effects[0].body, { ref: 'main', inputs: { name: 'reviewed', dry: true, count: 2 } });
      assert.deepEqual(outcome.result, {
        repositoryId: 42,
        workflowId: 10,
        runId: 22,
        ref: 'main',
        providerAcknowledged: true,
      });
      assert.equal(f.runs.get(22).status, 'queued');
    } else if (operation.kind === 'actions.rerun') {
      assert.equal(f.runs.get(20).run_attempt, 2);
      assert.equal(outcome.result.approvedAttempt, 1);
      assert.equal(outcome.result.request, 'rerun-requested');
      assert.equal(
        f.effects[0].path,
        `/repos/octocat/private/actions/runs/20/${operation.mode === 'failed' ? 'rerun-failed-jobs' : 'rerun'}`,
      );
    } else if (operation.kind === 'actions.cancel') {
      assert.equal(f.runs.get(21).conclusion, 'cancelled');
      assert.equal(outcome.result.request, 'cancellation-requested');
    } else {
      assert.equal(f.artifacts.has(30), false);
      assert.deepEqual(outcome.result, { repositoryId: 42, artifactId: 30, deleted: true });
    }
    assert.equal(f.effects.length, 1);
  });
for (const operation of actionsOperations.slice(1, 4))
  test(`documented empty object and null acknowledgement for ${operation.kind} ${operation.mode ?? ''}`, async t => {
    const f = await actionsProviderFixture();
    t.after(f.close);
    for (const value of [{}, null]) {
      f.state.value = value;
      assert.equal((await send(f, operation)).status, 'succeeded');
    }
    for (const value of [{ id: 999 }, [], 'ok']) {
      f.state.value = value;
      await assert.rejects(send(f, operation));
    }
    assert.equal(f.effects.length, 5);
  });
test('dispatch refuses legacy 204, missing run identity, wrong URL and credential reflection', async t => {
  const f = await actionsProviderFixture();
  t.after(f.close);
  const operation = actionsOperations[0];
  f.state.status = 204;
  assert.deepEqual(await send(f, operation), { status: 'unknown', result: null });
  f.state.status = null;
  for (const value of [
    {},
    {
      workflow_run_id: 22,
      run_url: 'https://evil.test',
      html_url: 'https://github.com/octocat/private/actions/runs/22',
    },
    { secret: credential.accessToken },
  ]) {
    f.state.value = value;
    await assert.rejects(send(f, operation));
  }
  f.state.value = undefined;
  assert.equal((await send(f, operation)).result.runId, 22);
});
for (const operation of actionsOperations)
  test(`${operation.kind} ${operation.mode ?? ''} status and scope failures never become success`, async t => {
    const f = await actionsProviderFixture();
    t.after(f.close);
    await assert.rejects(
      requireWriteTarget(operation, { ...credential, scopes: ['workflow'] }, f.fetcher, true),
      /batch-conflict/,
    );
    for (const status of [403, 404, 405, 409, 410, 422]) {
      f.state.status = status;
      assert.deepEqual(await send(f, operation), { status: 'rejected', result: null });
    }
    f.state.status = 401;
    await assert.rejects(send(f, operation));
    for (const status of [429, 500, 503, 200, 201, 202, 204]) {
      if (
        status ===
        { 'actions.dispatch': 200, 'actions.rerun': 201, 'actions.cancel': 202, 'actions.artifact-delete': 204 }[
          operation.kind
        ]
      )
        continue;
      f.state.status = status;
      assert.deepEqual(await send(f, operation), { status: 'unknown', result: null });
    }
    f.state.status = null;
    assert.equal((await send(f, operation)).status, 'succeeded');
  });
test('target preflight binds repository workflow attempt head and exact allowed state', async t => {
  const f = await actionsProviderFixture();
  t.after(f.close);
  for (const operation of actionsOperations) {
    for (const change of [{ repositoryId: 43 }])
      await assert.rejects(requireWriteTarget({ ...operation, ...change }, credential, f.fetcher, true));
    f.state.push = false;
    await assert.rejects(requireWriteTarget(operation, credential, f.fetcher, true));
    f.state.push = true;
    f.state.archived = true;
    await assert.rejects(requireWriteTarget(operation, credential, f.fetcher, true));
    f.state.archived = false;
  }
  for (const operation of actionsOperations.slice(1, 4))
    for (const change of [
      { runAttempt: 9 },
      { headSha: 'b'.repeat(40) },
      { workflowId: 99 },
      { expectedStatus: 'queued' },
    ])
      await assert.rejects(requireWriteTarget({ ...operation, ...change }, credential, f.fetcher, true));
  f.workflow.state = 'disabled_manually';
  await assert.rejects(requireWriteTarget(actionsOperations[0], credential, f.fetcher, true));
  f.workflow.state = 'active';
  await assert.rejects(requireWriteTarget({ ...actionsOperations[4], artifactId: 31 }, credential, f.fetcher, true));
  assert.equal(f.effects.length, 0);
  assert.equal((await send(f, actionsOperations[0])).status, 'succeeded');
});
for (const operation of actionsOperations)
  test(`lost ${operation.kind} ${operation.mode ?? ''} stays unknown despite matching state or absence`, async t => {
    const f = await actionsProviderFixture();
    t.after(f.close);
    f.state.lose = true;
    await assert.rejects(send(f, operation));
    const recover = () => reconcileGitHubWrite({ operation, credential, fetcher: f.fetcher, marker: 'unused' });
    const result = await recover();
    assert.equal(result.result, null);
    assert.equal(result.evidence.outcome, 'unresolved');
    if (operation.kind === 'actions.artifact-delete') assert.equal(result.evidence.status, 404);
    f.state.repositoryId = 99;
    await assert.rejects(recover());
    f.state.repositoryId = 42;
    f.state.readStatus = 403;
    assert.equal((await recover()).result, null);
    assert.equal(f.effects.length, 1);
  });
test('closed schemas reject administration URLs account overrides and unbounded inputs', () => {
  const dispatch = actionsOperations[0];
  for (const change of [
    { url: 'https://evil.test' },
    { method: 'POST' },
    { accountId: 'other' },
    { workflowId: 'ci.yml' },
    { inputs: Object.fromEntries(Array.from({ length: 26 }, (_, i) => [`key${i}`, 'x'])) },
    { inputs: { nested: {} } },
    { ref: '../main' },
  ])
    assert.equal(githubBatchInputSchema.safeParse({ actions: [{ ...dispatch, ...change }] }).success, false);
  for (const kind of [
    'actions.force-cancel',
    'actions.secret',
    'actions.environment',
    'actions.runner',
    'actions.run-delete',
  ])
    assert.equal(githubBatchInputSchema.safeParse({ actions: [{ ...dispatch, kind }] }).success, false);
  assert.deepEqual(githubBatchInputSchema.parse({ actions: [dispatch] }).actions[0], dispatch);
});
