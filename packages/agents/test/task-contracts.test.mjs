import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  delegatedTaskInputSchema,
  reopenTaskSchema,
  startTaskSchema,
  taskLimitsSchema,
  taskMessageSchema,
  taskSourcesSchema,
  taskSummarySchema,
  taskPauseReasonSchema,
} from '../src/task-contracts.ts';
import { taskFailurePauseReason } from '../src/task-pause.ts';

test('task summaries retain every structured pause reason and accept legacy absence', () => {
  const summary = taskSummarySchema.pick({ pauseReason: true });
  for (const pauseReason of taskPauseReasonSchema.options)
    assert.deepEqual(summary.parse({ pauseReason }), { pauseReason });
  assert.deepEqual(summary.parse({}), {});
  assert.deepEqual(summary.parse({ pauseReason: null }), { pauseReason: null });
  assert.throws(() => summary.parse({ pauseReason: 'unknown' }));
});

test('model generation failures retain the actual budget, context or file cause', () => {
  const cases = {
    'task-credits': 'limit.credits',
    'credits-exhausted': 'limit.workspaceCredits',
    'active-time': 'limit.activeTime',
    'tool-limit': 'limit.toolCalls',
    'context-limit': 'context',
    'context-overflow': 'context',
    'file-unsupported': 'file',
    'file-unavailable': 'file',
    'legacy-model-binding-required': 'model',
    'workspace-disabled': 'model',
    'model-route-unavailable': 'model',
    budget: 'model',
    deadline: 'model',
    'provider-error': 'model',
    'attempts-exhausted': 'model',
  };
  for (const [failure, expected] of Object.entries(cases))
    assert.equal(taskFailurePauseReason(failure), expected, failure);
  assert.equal(taskFailurePauseReason(null), 'model');
});

test('task commands normalize identifiers and reject execution authority, new budgets on reopen and untyped sources', () => {
  const requestId = randomUUID(),
    agentId = randomUUID();
  assert.deepEqual(startTaskSchema.parse({ requestId: requestId.toUpperCase(), agentId, text: ' Work ' }), {
    requestId,
    agentId,
    text: 'Work',
    scope: [],
    limits: { toolCalls: 100, activeMilliseconds: 300000, credits: 100 },
    sources: [],
  });

  for (const field of ['approved', 'ownerId', 'runId', 'generation'])
    assert.throws(() => startTaskSchema.parse({ requestId, agentId, text: 'Work', [field]: true }));
  assert.throws(() =>
    reopenTaskSchema.parse({ requestId, expectedGeneration: 0, text: 'Follow up', limits: { credits: 1000 } }),
  );
  const fileId = randomUUID();
  assert.deepEqual(
    taskSourcesSchema.parse([{ kind: 'file', fileId: fileId.toUpperCase() }]),
    [{ kind: 'file', fileId }],
    'a Files input names only the file',
  );
  assert.throws(() => taskSourcesSchema.parse([{ kind: 'file', fileId, authorized: true }]));
  const read = { readAt: '2026-10-05T00:00:00.000Z', sha256: 'f'.repeat(64), representation: 'text' };
  assert.deepEqual(
    taskSourcesSchema.parse([{ kind: 'file', fileId, read }]),
    [{ kind: 'file', fileId, read }],
    'a stored agent message keeps the runtime read receipt',
  );
  assert.throws(
    () => startTaskSchema.parse({ requestId, agentId, text: 'Work', sources: [{ kind: 'file', fileId, read }] }),
    /read/,
    'only the runtime writes a read receipt',
  );
  assert.throws(
    () =>
      reopenTaskSchema.parse({
        requestId,
        expectedGeneration: 0,
        text: 'Follow up',
        sources: [{ kind: 'file', fileId, read }],
      }),
    /read/,
  );
  const chatRead = { kind: 'tulipfarm-file', fileId, conversationId: agentId, membershipId: agentId, read };
  assert.deepEqual(taskSourcesSchema.parse([chatRead]), [chatRead], 'a stored message keeps a chat file read receipt');
  assert.throws(
    () => startTaskSchema.parse({ requestId, agentId, text: 'Work', sources: [chatRead] }),
    /kind/,
    'a person cannot attach a chat file read receipt',
  );
  assert.deepEqual(
    startTaskSchema.parse({ requestId, agentId, text: 'Work', sources: [{ kind: 'drive-file', fileId: 'drive_1-A' }] })
      .sources,
    [{ kind: 'drive-file', fileId: 'drive_1-A' }],
    'a person names a Drive file by id alone',
  );
  const bound = {
    kind: 'google-drive-file',
    fileId: 'drive_1-A',
    integrationId: agentId,
    accountId: 'account',
    generation: 1,
  };
  assert.deepEqual(
    taskSourcesSchema.parse([{ ...bound, read: { ...read, representation: 'export', version: '7' } }]),
    [{ ...bound, read: { ...read, representation: 'export', version: '7' } }],
    'a stored message keeps the server binding and runtime receipt',
  );
  assert.throws(
    () => startTaskSchema.parse({ requestId, agentId, text: 'Work', sources: [bound] }),
    /kind/,
    'a person cannot supply a Drive integration binding',
  );
  assert.throws(() =>
    startTaskSchema.parse({ requestId, agentId, text: 'Work', sources: [{ kind: 'drive-file', fileId: 'drive/1' }] }),
  );
  assert.throws(
    () => taskSourcesSchema.parse([{ kind: 'drive-file', fileId: 'drive_1-A' }]),
    'an unbound Drive input is never stored',
  );
  assert.throws(() => taskSourcesSchema.parse([{ kind: 'upload', fileId }]));
  assert.throws(() => taskSourcesSchema.parse([{ kind: 'task', taskId: randomUUID() }]));
  assert.throws(() => taskSourcesSchema.parse([{ kind: 'table', tableId: randomUUID(), authorized: true }]));
});

test('task limits reject values beyond the per-task maximums', () => {
  assert.throws(() => taskLimitsSchema.parse({ toolCalls: 1001, activeMilliseconds: 3600001, credits: 10001 }));
});

test('delegated task inputs are bounded and reject caller-supplied ownership or lineage', () => {
  const agentId = randomUUID();
  assert.deepEqual(delegatedTaskInputSchema.parse({ agentId, text: '  Review this  ' }), {
    agentId,
    text: 'Review this',
    limits: { toolCalls: 100, activeMilliseconds: 300000, credits: 100 },
  });
  for (const field of ['ownerUserId', 'parentTaskId', 'flowId', 'delegationDepth']) {
    assert.throws(() => delegatedTaskInputSchema.parse({ agentId, text: 'Review this', [field]: randomUUID() }));
  }
});

test('generated task messages preserve the complete protected source union with bounded explicit inputs', () => {
  const id = randomUUID();
  const sources = [
    { kind: 'table', tableId: id },
    { kind: 'table-rows', tableId: id, revision: 'records' },
    { kind: 'table-schema', tableId: id, revision: 'schema' },
    { kind: 'integration-source', integrationId: id, sourceId: id },
    {
      kind: 'github-personal',
      accountId: id,
      membershipId: id,
      generation: 1,
      conversationId: id,
      selectionVersion: 1,
    },
    { kind: 'github-source', integrationId: id, sourceId: id, generation: 1, grantsVersion: 1 },
    {
      kind: 'atlassian-source',
      accountId: id,
      sourceId: id,
      membershipId: id,
      generation: 1,
      grantsVersion: 1,
      binding: '{}',
    },
    {
      kind: 'google-integration',
      integrationId: id,
      accountId: 'account',
      membershipId: id,
      generation: 1,
      scopes: [],
      requiredScopes: [],
    },
    { kind: 'agent-definition', agentId: id, revision: 'definition' },
    { kind: 'workspace-skill', skillId: id, revision: 'skill' },
    { kind: 'creation-team', teamId: id, authority: 'agent' },
    { kind: 'private-conversation', conversationId: id },
    { kind: 'private-task', taskId: id },
    { kind: 'mcp-integration', integrationId: id, authorizationEpoch: 1 },
    { kind: 'shared-slack-turn', eventId: id },
    { kind: 'public-web', url: 'https://example.com/' },
    { kind: 'unknown' },
    { kind: 'unavailable' },
    { kind: 'task', taskId: id, throughSequence: 2 },
    { kind: 'attachment', conversationId: id, attachmentId: id },
    { kind: 'table', tableId: randomUUID() },
  ];
  const message = {
    sequence: 1,
    generation: 0,
    role: 'agent',
    text: 'Retained answer',
    createdAt: '2026-10-02',
    sources,
  };
  assert.deepEqual(taskMessageSchema.parse(message), message);
  assert.throws(() => startTaskSchema.parse({ requestId: id, agentId: id, text: 'Explicit input', sources }));
  assert.throws(() => taskSourcesSchema.parse(Array.from({ length: 1001 }, () => sources[0])));
});
