import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchGitHubWrite, writeBindingsSchema } from '../dist/write-provider.js';
import { actionsOperations } from './actions-provider-fixture.mjs';
import { mcpWriteFixture } from './mcp-write-fixture.mjs';

const credential = {
  accessToken: 'synthetic-actions-token',
  identity: { id: '123', login: 'octocat' },
  scopes: ['repo'],
};
for (const operation of actionsOperations.slice(1, 4))
  test(`qualified official actions_run_trigger ${operation.kind} ${operation.mode ?? ''} validates actual response`, async () => {
    const cancel = operation.kind === 'actions.cancel';
    const value = {
      run_id: operation.runId,
      status_code: cancel ? 202 : 201,
      status: cancel ? '202 Accepted' : '201 Created',
      message: cancel
        ? 'Workflow run has been cancelled'
        : operation.mode === 'failed'
          ? 'Failed jobs have been queued for re-run'
          : 'Workflow run has been queued for re-run',
    };
    const item = {
      operation,
      name: 'actions_run_trigger',
      args: {
        owner: 'octocat',
        repo: 'private',
        run_id: operation.runId,
        method: cancel
          ? 'cancel_workflow_run'
          : operation.mode === 'failed'
            ? 'rerun_failed_jobs'
            : 'rerun_workflow_run',
      },
      text: JSON.stringify(value),
    };
    for (const [result, expected] of [
      [{ content: [{ type: 'text', text: item.text }] }, 'succeeded'],
      [{ content: [{ type: 'text', text: JSON.stringify({ ...value, run_id: 999 }) }] }, 'unknown'],
      [{ content: [{ type: 'text', text: JSON.stringify({ ...value, status_code: 200 }) }] }, 'unknown'],
      [{ content: [{ type: 'text', text: 'Success' }] }, 'unknown'],
      [{ content: [{ type: 'text', text: item.text }], structuredContent: { id: 1 } }, 'unknown'],
      [{ content: [{ type: 'text', text: item.text }], isError: true }, 'unknown'],
      [{ content: [{ type: 'text', text: JSON.stringify({ ...value, secret: credential.accessToken }) }] }, 'unknown'],
    ]) {
      const effects = [],
        f = await mcpWriteFixture({ item, result, effect: call => effects.push(call) });
      try {
        const outcome = await dispatchGitHubWrite({
          operation,
          credential,
          bindings: writeBindingsSchema.parse(f.bindings),
          fetcher: f.fetcher,
          authorize: async () => true,
        });
        assert.equal(outcome.status, expected);
        assert.deepEqual(effects, [{ name: item.name, arguments: item.args }]);
        if (expected === 'succeeded')
          assert.deepEqual(outcome.result, {
            repositoryId: 42,
            workflowId: 10,
            runId: operation.runId,
            approvedAttempt: operation.runAttempt,
            headSha: 'a'.repeat(40),
            providerAcknowledged: true,
            request: cancel ? 'cancellation-requested' : 'rerun-requested',
          });
      } finally {
        await f.close();
      }
    }
    const f = await mcpWriteFixture({ item });
    try {
      const outcome = await dispatchGitHubWrite({
        operation,
        credential,
        bindings: [{ ...f.bindings[0], contractDigest: '0'.repeat(64) }],
        fetcher: f.fetcher,
        authorize: async () => true,
      });
      assert.deepEqual(outcome, { status: 'unknown', result: null });
      assert.equal(f.calls.length, 0);
    } finally {
      await f.close();
    }
  });
test('MCP dispatch that omits run identity and unsupported artifact deletion cannot be configured', () => {
  for (const operation of ['actions.dispatch', 'actions.artifact-delete'])
    assert.equal(
      writeBindingsSchema.safeParse([{ operation, name: 'actions_run_trigger', contractDigest: 'a'.repeat(64) }])
        .success,
      false,
    );
  assert.equal(
    writeBindingsSchema.parse([
      { operation: 'actions.cancel', name: 'actions_run_trigger', contractDigest: 'a'.repeat(64) },
    ])[0].operation,
    'actions.cancel',
  );
});
