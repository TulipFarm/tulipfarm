import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { authoringProposalSchema, draftOutcomeSchema, draftViewSchema } from '../src/draft-contracts.ts';

const settings = { name: 'Launch', instructions: 'Keep replies short.', archived: false };
const proposal = (instructions = settings.instructions, current = null) => ({
  kind: 'project',
  targetId: randomUUID(),
  input: {
    expectedRevision: current ? 1 : null,
    current,
    settings: { ...settings, instructions },
  },
});

function withoutBuffer(check) {
  const buffer = globalThis.Buffer;
  try {
    globalThis.Buffer = undefined;
    check();
  } finally {
    globalThis.Buffer = buffer;
  }
}

test('project draft contracts parse pending and settled browser responses without Node globals', () => {
  withoutBuffer(() => {
    for (const current of [null, settings, { ...settings, archived: true }]) {
      const change = proposal(undefined, current);
      assert.deepEqual(authoringProposalSchema.parse(change), change);
      for (const status of ['pending', 'saved', 'dismissed']) {
        const outcome =
          status === 'pending'
            ? null
            : status === 'dismissed'
              ? { kind: 'dismissed' }
              : { kind: 'project', projectId: change.targetId, revision: 2 };
        if (outcome) assert.deepEqual(draftOutcomeSchema.parse(outcome), outcome);
        const parsed = draftViewSchema.parse({
          id: randomUUID(),
          digest: 'd'.repeat(64),
          proposal: change,
          status,
          outcome,
        });
        assert.deepEqual(parsed.proposal, change);
        assert.equal(parsed.status, status);
        assert.deepEqual(parsed.outcome, outcome);
      }
    }
  });
});

test('project instruction limits count UTF-8 bytes identically in browser and server', () => {
  const buffer = Buffer;
  withoutBuffer(() => {
    for (const character of ['a', '\u00e9', '\u754c', '\u{1f337}']) {
      const size = buffer.byteLength(character);
      const atLimit = character.repeat(Math.floor(65536 / size)) + 'a'.repeat(65536 % size);
      assert.equal(buffer.byteLength(atLimit), 65536);
      assert.equal(authoringProposalSchema.safeParse(proposal(atLimit)).success, true);
      assert.equal(authoringProposalSchema.safeParse(proposal(atLimit + 'a')).success, false);
      const current = { ...settings, instructions: atLimit };
      assert.equal(authoringProposalSchema.safeParse(proposal('', current)).success, true);
      assert.equal(
        authoringProposalSchema.safeParse(proposal('', { ...current, instructions: atLimit + 'a' })).success,
        false,
      );
    }
  });
});
