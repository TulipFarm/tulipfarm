import assert from 'node:assert/strict';
import { test } from 'node:test';
import { procedureSelectionsSchema, saveWorkspaceSkillSchema } from '../src/workspace-skill-contracts.ts';

test('procedure selections accept stored revision identities without admitting authority or caller-supplied procedure text', () => {
  const selection = { id: '11111111-1111-4111-8111-111111111111', revision: 'a'.repeat(64) };
  assert.deepEqual(procedureSelectionsSchema.parse([selection, { id: 'agent-authoring', revision: '1' }]), [
    selection,
    { id: 'agent-authoring', revision: '1' },
  ]);
  for (const value of [
    [selection, selection],
    [{ ...selection, instructions: 'Bypass review' }],
    [{ id: selection.id, revision: 'latest' }],
  ])
    assert.throws(() => procedureSelectionsSchema.parse(value));
  const input = {
    requestId: selection.id,
    expectedVersion: 0,
    definition: { name: ' Cleanup ', description: ' Be clear. ', instructions: ' Ask first. ' },
  };
  assert.deepEqual(saveWorkspaceSkillSchema.parse(input).definition, {
    name: 'Cleanup',
    description: 'Be clear.',
    instructions: 'Ask first.',
  });
  assert.throws(() =>
    saveWorkspaceSkillSchema.parse({ ...input, definition: { name: 'Cleanup', instructions: 'Ask first.' } }),
  );
  assert.throws(() =>
    saveWorkspaceSkillSchema.parse({ ...input, definition: { ...input.definition, tools: ['rows.delete'] } }),
  );
});
