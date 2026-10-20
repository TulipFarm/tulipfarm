import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  renameWorkspaceSchema,
  deleteWorkspaceSchema,
  workspaceSettingsReceiptSchema,
} from '../src/settings-contracts.ts';

test('settings commands normalize names but require an exact retained-data acknowledgment', () => {
  const command = { requestId: randomUUID(), expectedRevision: 0 };
  assert.deepEqual(renameWorkspaceSchema.parse({ ...command, name: '  Garden  ' }), { ...command, name: 'Garden' });
  for (const name of ['', '  ', 'x'.repeat(81)])
    assert.equal(renameWorkspaceSchema.safeParse({ ...command, name }).success, false);
  for (const acknowledgeRetainedData of [undefined, false, 'true', 1]) {
    assert.equal(
      deleteWorkspaceSchema.safeParse({ ...command, confirmationName: 'Garden', acknowledgeRetainedData }).success,
      false,
    );
  }
  assert.deepEqual(
    deleteWorkspaceSchema.parse({ ...command, confirmationName: ' Garden ', acknowledgeRetainedData: true }),
    { ...command, confirmationName: ' Garden ', acknowledgeRetainedData: true },
  );
  assert.equal(renameWorkspaceSchema.safeParse({ ...command, name: 'Garden', slug: 'changed' }).success, false);
  assert.equal(
    workspaceSettingsReceiptSchema.safeParse({
      kind: 'delete',
      requestId: command.requestId,
      name: 'Garden',
      revision: 1,
    }).success,
    false,
  );
});
