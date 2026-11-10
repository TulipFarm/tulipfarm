import assert from 'node:assert/strict';
import { test } from 'node:test';
import { definitionSchema } from '@tulipfarm/workflows/contracts';
import { runInputFields, runInputExample } from '../src/features/workflows/run-input.ts';
import { inputErrorNote } from '../src/features/workflows/run-notes.ts';

const definition = (fields: Record<string, unknown>) =>
  definitionSchema.parse({
    version: 1,
    name: 'Copy input',
    triggers: [],
    steps: [{ id: 'copy', kind: 'transform', fields }],
  });
const input = (...path: string[]) => ({ kind: 'input', path });

test('manual fields use the input keys, deduplicate them, and keep request when it is read', () => {
  const reads = definition({ first: input('name'), second: input('name'), third: input('request') });
  assert.deepEqual(runInputFields(reads), ['name', 'request']);
  assert.deepEqual(runInputExample(reads), { name: '', request: '' });
});

test('nested, whole-input and unknown inputs use JSON with a matching starting shape', () => {
  const nested = definition({ name: input('person', 'name'), city: input('person', 'city') });
  assert.equal(runInputFields(nested), null);
  assert.deepEqual(runInputExample(nested), { person: { name: '', city: '' } });
  const whole = definition({ all: input(), name: input('name') });
  assert.equal(runInputFields(whole), null);
  assert.deepEqual(runInputExample(whole), { name: '' });
  const none = definition({ constant: { kind: 'literal', value: { kind: 'input', path: ['not_a_field'] } } });
  assert.equal(runInputFields(none), null);
  assert.deepEqual(runInputExample(none), {});
});

test('fields include inputs in conditions, code mappings, headers and Slack templates', () => {
  const reads = definitionSchema.parse({
    version: 1,
    name: 'Mapped input',
    triggers: [],
    steps: [
      {
        id: 'check',
        kind: 'condition',
        when: { left: input('ready'), op: 'not-empty' },
        ifMet: ['code'],
        otherwise: [],
      },
      { id: 'code', kind: 'code', language: 'javascript', source: 'return input;', input: input('code_input') },
      {
        id: 'send',
        kind: 'http',
        url: 'https://example.test',
        method: 'POST',
        headers: { 'x-id': input('id') },
        body: input('body'),
      },
      {
        id: 'slack',
        kind: 'slack-message',
        destinationId: '00000000-0000-4000-8000-000000000001',
        text: { kind: 'template', template: 'Hello {{name}}', values: { name: input('name') } },
      },
    ],
  });
  assert.deepEqual(runInputFields(reads), ['ready', 'code_input', 'id', 'body', 'name']);
});

test('input errors name missing or invalid fields without exposing their values', () => {
  const steps = definition({ name: input('name') }).steps;
  assert.match(inputErrorNote('table-input-invalid', steps, {}), /"name".*missing.*fill.*run.*again/i);
  assert.match(inputErrorNote('table-input-invalid', steps, { name: 12 }), /"name".*invalid.*correct.*run.*again/i);
  assert.doesNotMatch(inputErrorNote('table-input-invalid', steps, { name: 'private value' }), /private value/);
  assert.match(inputErrorNote('missing-value', steps, {}), /"name"/);
  assert.match(inputErrorNote('table-input-invalid', [], {}), /input.*JSON/i);
  assert.equal(inputErrorNote('unrelated-error', steps, {}), null);
});
