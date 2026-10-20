import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRecipients, sendInvitationBatch, type RecipientState } from '../src/lib/invitation-batch.ts';

test('recipient parsing uses invitation normalization and deduplicates before issuing commands', () => {
  assert.deepEqual(parseRecipients(' Ada@Example.com, bob@example.com\nada@example.com\nwrong, ,'), {
    recipients: ['ada@example.com', 'bob@example.com'],
    invalid: ['wrong'],
    duplicates: ['ada@example.com'],
  });
  assert.deepEqual(
    parseRecipients('ab@gmail.com, ab+1@gmail.com, A.b@gmail.com, ab@googlemail.com, a+1@company.com, a@company.com'),
    {
      recipients: ['ab@gmail.com', 'a+1@company.com', 'a@company.com'],
      invalid: [],
      duplicates: ['ab+1@gmail.com', 'a.b@gmail.com', 'ab@googlemail.com'],
    },
  );
  assert.equal(
    parseRecipients(Array.from({ length: 250 }, (_, i) => `person${i}@example.com`).join(',')).recipients.length,
    250,
  );
});

test('large batches retain bounded concurrency and stop on the server rate limit', async () => {
  const commands = Array.from({ length: 100 }, (_, i) => ({ email: `person${i}@example.com`, requestId: String(i) }));
  let calls = 0;
  const outcomes = new Map<string, RecipientState>();
  await sendInvitationBatch(
    commands,
    async () => {
      calls++;
      return { kind: 'failed', code: 'rate-limited' };
    },
    (command, state) => outcomes.set(command.email, state),
  );
  assert.equal(calls, 2);
  assert.equal(outcomes.size, 100);
  assert.ok([...outcomes.values()].every(state => state.kind === 'failed' && state.code === 'rate-limited'));
});

test('batches larger than twenty send every recipient', async () => {
  const commands = Array.from({ length: 45 }, (_, i) => ({ email: `person${i}@example.com`, requestId: String(i) }));
  const sent = new Set<string>();
  await sendInvitationBatch(
    commands,
    async command => {
      sent.add(command.requestId);
      return { kind: 'success', result: { outcome: 'already-member' } };
    },
    () => {},
  );
  assert.equal(sent.size, 45);
});

test('bounded queue retains independent success and stops new writes after access loss', async () => {
  const commands = ['a', 'b', 'c', 'd'].map(email => ({ email: `${email}@example.com`, requestId: email }));
  const outcomes = new Map<string, RecipientState>();
  let active = 0;
  let peak = 0;
  await sendInvitationBatch(
    commands,
    async command => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, command.requestId === 'a' ? 20 : 1));
      active--;
      return command.requestId === 'a'
        ? { kind: 'success', result: { outcome: 'already-member' } }
        : { kind: 'failed', code: 'access-lost' };
    },
    (command, state) => outcomes.set(command.email, state),
  );
  assert.equal(peak, 2);
  assert.deepEqual(
    [...outcomes],
    [
      ['a@example.com', { kind: 'success', result: { outcome: 'already-member' } }],
      ['b@example.com', { kind: 'failed', code: 'access-lost' }],
      ['c@example.com', { kind: 'failed', code: 'access-lost' }],
      ['d@example.com', { kind: 'failed', code: 'access-lost' }],
    ],
  );
});
