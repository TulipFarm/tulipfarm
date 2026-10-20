import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  approvalSchema,
  approvalDetails,
  informationSchema,
  interactionPending,
} from '../src/features/chat/interaction-contracts.ts';

const identity = {
  id: randomUUID(),
  turnId: randomUUID(),
  revision: 1,
  prompt: 'Decide now?',
  expiresAt: '2026-10-01T00:00:00Z',
};
test('request hydration projects typed answers and polling follows durable state', () => {
  const request = informationSchema.parse({
    ...identity,
    answerSchema: { kind: 'text' },
    status: 'pending',
    response: null,
    internalHistory: 'private',
  });
  assert.deepEqual(request, { ...identity, answerSchema: { kind: 'text' }, status: 'pending', response: null });
  assert.equal(interactionPending({ kind: 'information', request }), true);
  const response = {
    id: randomUUID(),
    answer: { kind: 'choices', choiceIds: ['yes'] },
    createdAt: '2026-09-29T00:00:00Z',
  };
  const answered = informationSchema.parse({
    ...identity,
    answerSchema: { kind: 'choices', multiple: false, choices: [{ id: 'yes', label: 'Yes' }] },
    status: 'answered',
    response,
  });
  assert.deepEqual(answered.response, response);
  assert.equal(interactionPending({ kind: 'information', request: answered }), false);
});

test('approval details expose only known effect fields and never claim execution', () => {
  const tableId = randomUUID(),
    migrationId = randomUUID(),
    fieldId = randomUUID();
  const request = approvalSchema.parse({
    ...identity,
    action: {
      kind: 'table-migration',
      tableId,
      migrationId,
      planDigest: 'a'.repeat(64),
      expectedAppliedRevision: 'b'.repeat(40),
      effect: { kind: 'drop-field', tableId, fieldId, rowCount: 3, privateToolResult: 'secret' },
    },
    resolution: null,
  });
  assert.equal(interactionPending({ kind: 'approval', request }), true);
  assert.deepEqual(approvalDetails(request), [
    { label: 'Action', value: 'Change table schema' },
    { label: 'Table', value: tableId },
    { label: 'Proposal', value: migrationId },
    { label: 'Plan digest', value: 'a'.repeat(64) },
    { label: 'Applied revision', value: 'b'.repeat(40) },
    { label: 'Effect', value: 'Remove field values' },
    { label: 'Affected rows', value: '3' },
    { label: 'Field', value: fieldId },
  ]);
  request.action.effect = { kind: 'unknown-operation', privateToolResult: 'secret' };
  assert.deepEqual(approvalDetails(request).at(-1), {
    label: 'Effect',
    value: 'Effect details unavailable. Do not approve an action you cannot verify.',
  });
  request.resolution = { requestId: request.id, revision: 1, status: 'approved', confirmationId: randomUUID() };
  assert.equal(interactionPending({ kind: 'approval', request }), false);
});
