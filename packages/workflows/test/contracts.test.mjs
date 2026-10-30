import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  authoredDefinitionSchema,
  ConditionIncomparable,
  definitionSchema,
  evaluateCondition,
  githubTriggerSchema,
  nextStep,
  recordFilterSchema,
  runCondition,
  saveSchema,
  transform,
  waitUntilInstant,
} from '../src/contracts.ts';

test('a GitHub trigger names only actions its event has, each once', () => {
  const trigger = actions =>
    githubTriggerSchema.safeParse({ kind: 'github', repositoryId: '42', event: 'star', actions }).success;
  assert.equal(trigger(undefined), true);
  assert.equal(trigger(['created', 'deleted']), true);
  assert.equal(trigger(['opened']), false);
  assert.equal(trigger(['created', 'created']), false);
  assert.equal(
    githubTriggerSchema.safeParse({ kind: 'github', repositoryId: '42', event: 'push', actions: ['created'] }).success,
    false,
  );
  assert.equal(githubTriggerSchema.safeParse({ kind: 'github', repositoryId: '42', event: 'fork' }).success, false);
});

test('saving rejects copied signature and secret headers but stored revisions still parse', () => {
  const webhook = headers => ({
    version: 1,
    name: 'GitHub pushes',
    trigger: {
      kind: 'webhook',
      payload: { mode: 'raw', dedupe: { source: 'header', name: 'x-github-delivery' }, headers },
    },
    steps: [{ id: 'note', kind: 'transform', fields: { event: { kind: 'input', path: [] } } }],
  });
  assert.equal(authoredDefinitionSchema.safeParse(webhook(['x-github-event', 'x-github-hook-id'])).success, true);
  for (const header of [
    'x-hub-signature-256',
    'x-hub-signature',
    'stripe-signature',
    'svix-signature',
    'webhook-secret',
    'x-shopify-access-token',
  ]) {
    const authored = authoredDefinitionSchema.safeParse(webhook(['x-github-event', header]));
    assert.equal(authored.success, false, header);
    assert.deepEqual(
      authored.error.issues.map(issue => issue.path),
      [['trigger', 'payload', 'headers', 1]],
    );
    assert.equal(definitionSchema.safeParse(webhook(['x-github-event', header])).success, true, `stored ${header}`);
  }
});

test('saving rejects a nonexistent earlier output field but historical definitions remain readable', () => {
  const source = { id: 'source', kind: 'transform', fields: { total: { kind: 'literal', value: 12 } } };
  const copy = {
    id: 'copy',
    kind: 'transform',
    fields: { total: { kind: 'step', step: 'source', path: ['nonsense'] } },
  };
  const definition = { version: 1, name: 'Output path repro', trigger: { kind: 'manual' }, steps: [source, copy] };
  assert.equal(definitionSchema.safeParse(definition).success, true);
  const saved = saveSchema.safeParse({
    revision: '11111111-1111-4111-8111-111111111111',
    expectedRevision: null,
    definition,
  });
  assert.equal(saved.success, false);
  assert.match(saved.error.issues[0].message, /copy.*source.*nonsense/);
  assert.deepEqual(saved.error.issues[0].path, ['definition', 'steps', 1, 'fields', 'total', 'path']);
});

test('ordered definitions reject forward references and transforms resolve literal input and receipts', () => {
  const step = {
    id: 'result',
    kind: 'transform',
    fields: {
      total: { kind: 'input', path: ['total'] },
      accepted: { kind: 'step', step: 'review', path: ['yes'] },
      label: { kind: 'literal', value: 'Done' },
    },
  };
  assert.deepEqual(transform(step, { total: 12 }, new Map([['review', { yes: true }]])), {
    total: 12,
    accepted: true,
    label: 'Done',
  });
  assert.throws(() => definitionSchema.parse({ version: 1, name: 'Test', trigger: { kind: 'manual' }, steps: [step] }));
  assert.throws(() => transform(step, {}, new Map([['review', { yes: true }]])), /missing-value/);
  assert.equal(
    definitionSchema.parse({
      version: 1,
      name: 'Test',
      trigger: { kind: 'manual' },
      steps: [{ id: 'review', kind: 'human', prompt: 'Review', timeoutSeconds: 60 }, step],
    }).steps.length,
    2,
  );
});

test('native Slack workflow messages require destination IDs and bounded text mappings', () => {
  const step = {
    id: 'notify',
    kind: 'slack-message',
    destinationId: '7c0b8c7e-4f0e-4e3b-9a52-0d3f1f2b6a11',
    text: { kind: 'input', path: ['values', 'title', 'value'] },
  };
  const parse = step =>
    definitionSchema.safeParse({ version: 1, name: 'Tickets', trigger: { kind: 'manual' }, steps: [step] }).success;
  assert.equal(parse(step), true);
  assert.equal(parse({ ...step, destinationId: 'C12345' }), false);
  for (const value of ['', 'x'.repeat(4001), 12, { kind: 'text', value: 'Title' }])
    assert.equal(parse({ ...step, text: { kind: 'literal', value } }), false);
  assert.equal(parse({ ...step, text: { kind: 'literal', value: 'Ticket created' } }), true);
  assert.equal(parse({ ...step, text: { kind: 'step', step: 'later', path: [] } }), false);
});

test('agent steps use a prior value as a bounded task prompt', () => {
  const agentId = '7c0b8c7e-4f0e-4e3b-9a52-0d3f1f2b6a11';
  const parse = steps =>
    definitionSchema.safeParse({ version: 1, name: 'Agent', trigger: { kind: 'manual' }, steps }).success;
  assert.equal(
    parse([
      {
        id: 'draft',
        kind: 'agent',
        agentId,
        prompt: { kind: 'input', path: ['message'] },
        limits: { toolCalls: 12, activeMilliseconds: 6000, credits: 4 },
      },
      { id: 'copy', kind: 'transform', fields: { reply: { kind: 'step', step: 'draft', path: ['result'] } } },
    ]),
    true,
  );
  assert.equal(
    parse([
      { id: 'draft', kind: 'agent', agentId, prompt: { kind: 'step', step: 'later', path: [] } },
      { id: 'later', kind: 'transform', fields: {} },
    ]),
    false,
  );
  assert.equal(
    parse([
      {
        id: 'draft',
        kind: 'agent',
        agentId,
        prompt: { kind: 'literal', value: 'Reply' },
        limits: { toolCalls: 1001, activeMilliseconds: 6000, credits: 4 },
      },
    ]),
    false,
  );
});

test('HTTP steps require HTTPS, keep credential values out of definitions, and read earlier request values', () => {
  const integrationId = '7c0b8c7e-4f0e-4e3b-9a52-0d3f1f2b6a11';
  const parse = step =>
    definitionSchema.safeParse({
      version: 1,
      name: 'Notify',
      trigger: { kind: 'manual' },
      steps: [{ id: 'message', kind: 'transform', fields: { text: { kind: 'input', path: ['text'] } } }, step],
    }).success;
  const valid = {
    id: 'notify',
    kind: 'http',
    method: 'POST',
    url: 'https://hooks.example.com/notify',
    headers: { 'x-event': { kind: 'literal', value: 'order-created' } },
    credential: { integrationId, header: 'x-api-key' },
    body: { kind: 'step', step: 'message', path: [] },
  };
  assert.equal(parse(valid), true);
  assert.equal(parse({ ...valid, url: 'http://hooks.example.com/notify' }), false);
  assert.deepEqual(
    definitionSchema
      .safeParse({
        version: 1,
        name: 'Notify',
        trigger: { kind: 'manual' },
        steps: [{ ...valid, body: undefined, url: 'hooks' }],
      })
      .error?.issues.map(issue => [issue.code, issue.path.join('.')]),
    [['invalid_format', 'steps.0.url']],
    'a malformed URL reports one format issue instead of throwing',
  );
  assert.equal(parse({ ...valid, headers: { authorization: { kind: 'literal', value: 'secret' } } }), false);
  assert.equal(parse({ ...valid, method: 'GET', body: valid.body }), false);
  assert.equal(parse({ ...valid, body: { kind: 'step', step: 'later', path: [] } }), false);
});

test('wait-until steps accept ISO instants or earlier references and delays allow up to 366 days', () => {
  const definition = steps => ({ version: 1, name: 'Wait', trigger: { kind: 'manual' }, steps });
  const parse = steps => definitionSchema.safeParse(definition(steps)).success;
  assert.equal(
    parse([{ id: 'start', kind: 'wait-until', at: { kind: 'literal', value: '2027-01-31T09:00:00+01:00' } }]),
    true,
  );
  assert.equal(parse([{ id: 'start', kind: 'wait-until', at: { kind: 'literal', value: '2027-01-31' } }]), true);
  assert.equal(parse([{ id: 'start', kind: 'wait-until', at: { kind: 'literal', value: 'next tuesday' } }]), false);
  assert.equal(parse([{ id: 'start', kind: 'wait-until', at: { kind: 'literal', value: 1798707600000 } }]), false);
  assert.equal(parse([{ id: 'start', kind: 'wait-until', at: { kind: 'input', path: ['contract', 'start'] } }]), true);
  assert.equal(
    parse([
      { id: 'start', kind: 'wait-until', at: { kind: 'step', step: 'later', path: [] } },
      { id: 'later', kind: 'delay', seconds: 1 },
    ]),
    false,
  );
  assert.equal(parse([{ id: 'pause', kind: 'delay', seconds: 366 * 86400 }]), true);
  assert.equal(parse([{ id: 'pause', kind: 'delay', seconds: 366 * 86400 + 1 }]), false);
  assert.equal(waitUntilInstant('2027-01-31T09:00:00+01:00').toISOString(), '2027-01-31T08:00:00.000Z');
  assert.equal(waitUntilInstant('2027-01-31').toISOString(), '2027-01-31T00:00:00.000Z');
  assert.throws(() => waitUntilInstant('2027-01-31T09:00:00'), /wait-until-invalid/);
  assert.throws(() => waitUntilInstant({ at: '2027-01-31' }), /wait-until-invalid/);
});

test('table steps validate their table, fields, limit and references to earlier steps', () => {
  const tableId = '7c0b8c7e-4f0e-4e3b-9a52-0d3f1f2b6a11',
    fieldId = '1d6f0f5a-2b9e-4c41-8f7a-5e0c4b1a9d22';
  const parse = steps =>
    definitionSchema.safeParse({ version: 1, name: 'Rows', trigger: { kind: 'manual' }, steps }).success;
  const find = {
    id: 'find',
    kind: 'find-rows',
    tableId,
    filters: [{ fieldId, op: 'eq', value: { kind: 'input', path: ['name'] } }],
    limit: 10,
  };
  const update = {
    id: 'close',
    kind: 'update-row',
    tableId,
    row: { kind: 'step', step: 'find', path: ['rows', '0'] },
    fields: { [fieldId]: { kind: 'literal', value: 'Closed' } },
  };
  assert.equal(parse([find, update]), true);
  assert.equal(parse([update, find]), false, 'an update cannot read a row from a later step');
  assert.equal(parse([{ ...find, limit: 51 }]), false);
  assert.equal(parse([{ ...find, filters: [{ fieldId, op: 'is-null' }] }]), true);
  assert.equal(
    parse([{ ...find, filters: [{ fieldId, op: 'is-null', value: { kind: 'literal', value: 1 } }] }]),
    false,
  );
  assert.equal(
    parse([{ id: 'add', kind: 'create-row', tableId, fields: {} }]),
    false,
    'a create maps at least one field',
  );
  assert.equal(
    parse([
      { id: 'add', kind: 'create-row', tableId, fields: { [fieldId.toUpperCase()]: { kind: 'literal', value: 'x' } } },
    ]),
    false,
    'field IDs are lowercase',
  );
  assert.equal(
    parse([
      { id: 'add', kind: 'create-row', tableId, fields: { [fieldId]: { kind: 'step', step: 'missing', path: [] } } },
    ]),
    false,
  );
});

test('row triggers name one event, watch fields only on updates, and refuse steps that would retrigger them', () => {
  const tableId = '7c0b8c7e-4f0e-4e3b-9a52-0d3f1f2b6a11',
    fieldId = '1d6f0f5a-2b9e-4c41-8f7a-5e0c4b1a9d22',
    otherId = '2e7a1b6c-3c0f-4d52-9a8b-6f1d5c2b0e33';
  const note = { id: 'note', kind: 'transform', fields: { id: { kind: 'input', path: ['recordId'] } } };
  const parse = (trigger, steps = [note]) =>
    definitionSchema.safeParse({ version: 1, name: 'Rows', trigger: { kind: 'row', tableId, ...trigger }, steps })
      .success;
  assert.equal(parse({ event: 'created' }), true);
  assert.equal(parse({ event: 'deleted' }), true);
  assert.equal(parse({ event: 'updated', fieldIds: [fieldId] }), true);
  assert.equal(parse({ event: 'created', fieldIds: [fieldId] }), false, 'only an update has changed fields to watch');
  assert.equal(parse({ event: 'moved' }), false);
  const create = { id: 'copy', kind: 'create-row', tableId, fields: { [fieldId]: { kind: 'literal', value: 'x' } } };
  const update = {
    id: 'touch',
    kind: 'update-row',
    tableId,
    row: { kind: 'input', path: [] },
    fields: { [fieldId]: { kind: 'literal', value: 'x' } },
  };
  assert.equal(
    parse({ event: 'created' }, [create]),
    false,
    'creating a row in the watched table would start another run',
  );
  assert.equal(
    parse({ event: 'updated' }, [update]),
    false,
    'updating a row in the watched table would start another run',
  );
  assert.equal(
    parse({ event: 'updated', fieldIds: [otherId] }, [update]),
    true,
    'an update to fields the trigger does not watch starts no run',
  );
  assert.equal(parse({ event: 'updated', fieldIds: [fieldId] }, [update]), false);
  assert.equal(parse({ event: 'deleted' }, [create, update]), true, 'no step deletes rows');
  assert.equal(parse({ event: 'created' }, [{ ...create, tableId: otherId }]), true);
});

test('record filters compare text, yes or no and options for equality, numbers and dates in order, and any field for no value', () => {
  const fieldId = '1d6f0f5a-2b9e-4c41-8f7a-5e0c4b1a9d22';
  const parse = filter => recordFilterSchema.safeParse({ fieldId, ...filter }).success;
  assert.equal(parse({ match: 'is', value: { kind: 'text', value: 'Open' } }), true);
  assert.equal(parse({ match: 'gte', value: { kind: 'numeric', value: '1000.50' } }), true);
  assert.equal(parse({ match: 'lt', value: { kind: 'numeric', value: '-3' } }), true);
  assert.equal(
    parse({ match: 'lt', value: { kind: 'numeric', value: '1e5' } }),
    false,
    'numbers are plain decimals, as table values are',
  );
  assert.equal(parse({ match: 'is-not', value: { kind: 'date', value: '2027-01-31' } }), true);
  assert.equal(parse({ match: 'gt', value: { kind: 'timestamp', value: '2027-01-31T09:00:00Z' } }), true);
  assert.equal(parse({ match: 'gt', value: { kind: 'text', value: 'B' } }), false, 'text has no order to compare');
  assert.equal(parse({ match: 'lt', value: { kind: 'boolean', value: true } }), false);
  assert.equal(parse({ match: 'is-empty' }), true);
  assert.equal(parse({ match: 'is-not-empty' }), true);
  assert.equal(
    parse({ match: 'is-empty', value: { kind: 'text', value: 'x' } }),
    false,
    'an empty check takes no value',
  );
});

test('condition steps branch over later steps and only read steps that run whenever they run', () => {
  const parse = steps => definitionSchema.safeParse({ version: 1, name: 'Branch', trigger: { kind: 'manual' }, steps });
  const note = id => ({ id, kind: 'transform', fields: { note: { kind: 'literal', value: id } } });
  const check = (
    branches,
    when = { left: { kind: 'input', path: ['total'] }, op: 'gt', right: { kind: 'literal', value: 100 } },
  ) => ({ id: 'check', kind: 'condition', when, ...branches });
  assert.equal(parse([check({ ifMet: ['big'], otherwise: ['small'] }), note('big'), note('small')]).success, true);
  assert.equal(
    parse([
      check({ ifMet: [], otherwise: ['rest'] }, { left: { kind: 'input', path: ['email'] }, op: 'is-empty' }),
      note('rest'),
    ]).success,
    true,
  );
  assert.equal(
    parse([check({ ifMet: [], otherwise: [] }), note('big')]).success,
    false,
    'a condition names a step to run or skip',
  );
  assert.equal(
    parse([check({ ifMet: ['big'], otherwise: ['big'] }), note('big')]).success,
    false,
    'a step belongs to one branch',
  );
  assert.equal(
    parse([note('big'), check({ ifMet: ['big'], otherwise: [] })]).success,
    false,
    'a branch names later steps',
  );
  assert.equal(parse([check({ ifMet: ['missing'], otherwise: [] }), note('big')]).success, false);
  assert.equal(
    parse([
      check(
        { ifMet: ['big'], otherwise: [] },
        { left: { kind: 'input', path: [] }, op: 'is-empty', right: { kind: 'literal', value: 1 } },
      ),
      note('big'),
    ]).success,
    false,
    'empty checks take no right value',
  );
  const reads = (id, step) => ({ id, kind: 'transform', fields: { copied: { kind: 'step', step, path: [] } } });
  assert.equal(
    parse([check({ ifMet: ['big', 'copy'], otherwise: [] }), note('big'), reads('copy', 'big')]).success,
    true,
    'a step on the same branch reads it',
  );
  assert.equal(
    parse([check({ ifMet: ['big'], otherwise: [] }), note('big'), reads('copy', 'big')]).success,
    false,
    'an unconditional step cannot read a skippable step',
  );
  assert.equal(
    parse([check({ ifMet: ['big'], otherwise: ['copy'] }), note('big'), reads('copy', 'big')]).success,
    false,
    'the other branch cannot read it',
  );
  assert.equal(
    parse([check({ ifMet: ['big'], otherwise: [] }), note('big'), reads('copy', 'check')]).success,
    true,
    'every step can read the condition receipt',
  );
  const nested = {
    id: 'inner',
    kind: 'condition',
    when: { left: { kind: 'input', path: ['rush'] }, op: 'eq', right: { kind: 'literal', value: true } },
    ifMet: ['call'],
    otherwise: [],
  };
  assert.equal(
    parse([check({ ifMet: ['inner', 'big'], otherwise: [] }), nested, note('call'), reads('big', 'call')]).success,
    false,
    'a step outside a nested branch cannot read inside it',
  );
  assert.equal(
    parse([check({ ifMet: ['inner', 'big'], otherwise: [] }), nested, note('call'), reads('big', 'inner')]).success,
    true,
  );
});

test('conditions compare typed table values, dates and plain JSON, and walk past skipped steps', () => {
  const when = (left, op, right) => ({
    left: { kind: 'literal', value: left },
    op,
    ...(right === undefined ? {} : { right: { kind: 'literal', value: right } }),
  });
  const evaluate = (...args) => evaluateCondition(when(...args), {}, new Map());
  assert.equal(evaluate({ kind: 'numeric', value: '1250.50' }, 'gt', 999), true);
  assert.equal(evaluate({ kind: 'numeric', value: '10' }, 'eq', 10), true);
  assert.equal(evaluate({ kind: 'single-select', optionId: 'open' }, 'ne', 'closed'), true);
  assert.equal(evaluate({ kind: 'text', value: 'Acme' }, 'eq', 'Acme'), true);
  assert.equal(evaluate('2026-10-09', 'lt', '2026-10-09T12:00:00+05:30'), true, 'a date is midnight UTC');
  assert.equal(evaluate('2026-10-09T10:00:00+05:30', 'gt', '2026-10-09T05:00:00Z'), false, 'times compare as instants');
  assert.equal(evaluate('apple', 'lt', 'banana'), true);
  assert.equal(evaluate({ a: [1, 2], b: 1 }, 'eq', { b: 1, a: [1, 2] }), true, 'objects compare by content');
  assert.equal(evaluate('', 'is-empty'), true);
  assert.equal(evaluate([], 'is-empty'), true);
  assert.equal(evaluate({ kind: 'text', value: null }, 'is-empty'), true);
  assert.equal(evaluate(0, 'not-empty'), true);
  assert.equal(
    evaluateCondition({ left: { kind: 'input', path: ['missing'] }, op: 'is-empty' }, {}, new Map()),
    true,
    'a missing value is empty',
  );
  assert.equal(evaluate('9', 'lt', '10'), false, 'plain strings order as text');
  assert.equal(evaluate('00012', 'eq', '12'), false, 'plain strings remain distinct');
  assert.equal(
    evaluate({ kind: 'numeric', value: '250.00' }, 'lt', 1000),
    true,
    'a typed table number compares with a JSON number',
  );
  assert.equal(
    evaluate({ kind: 'numeric', value: '1000000000000000000000' }, 'eq', 1e21),
    true,
    'a JSON exponent number compares with a typed number',
  );
  assert.equal(
    evaluate({ kind: 'numeric', value: '0.0000001' }, 'eq', 1e-7),
    true,
    'a small JSON exponent number compares with a typed number',
  );
  assert.equal(evaluate(1e21, 'eq', 1e21), true, 'JSON exponent numbers compare by value');
  assert.equal(evaluate(-0, 'eq', 0), true);
  assert.equal(evaluate({ kind: 'numeric', value: '-1.5' }, 'lt', -1.25), true);
  assert.equal(
    evaluate({ kind: 'numeric', value: '1234567890123456789012345678901234567891' }, 'gt', {
      kind: 'numeric',
      value: '1234567890123456789012345678901234567890',
    }),
    true,
    'long typed decimals keep their precision',
  );
  assert.equal(
    evaluate('2026-10-09T00:00:00Z', 'eq', '2026-10-09T00:00:00.000Z'),
    true,
    'equal instants are equal whatever their spelling',
  );
  assert.equal(
    evaluate({ kind: 'date', value: '2026-10-09' }, 'eq', { kind: 'timestamp', value: '2026-10-09T00:00:00Z' }),
    true,
  );
  assert.equal(evaluate('2026-10-09T00:00:00Z', 'ne', '2026-10-09T00:00:00.000Z'), false);
  assert.throws(
    () => evaluate({ kind: 'numeric', value: 'twelve' }, 'gt', 5),
    ConditionIncomparable,
    'a malformed table number fails instead of taking a branch',
  );
  assert.throws(() => evaluate({ kind: 'numeric', value: 'twelve' }, 'eq', 5), ConditionIncomparable);
  assert.throws(() => evaluate('10', 'gt', 5), ConditionIncomparable, 'a plain string is not a JSON number');
  assert.throws(() => evaluate('lots', 'gt', 5), ConditionIncomparable);
  assert.throws(() => evaluate(null, 'lt', 5), /condition-values-incomparable/);

  const steps = definitionSchema.parse({
    version: 1,
    name: 'Walk',
    trigger: { kind: 'manual' },
    steps: [
      { id: 'check', kind: 'condition', when: when(1, 'eq', 1), ifMet: ['inner'], otherwise: ['other'] },
      { id: 'inner', kind: 'condition', when: when(1, 'eq', 2), ifMet: ['deep'], otherwise: [] },
      { id: 'deep', kind: 'transform', fields: {} },
      { id: 'other', kind: 'transform', fields: {} },
      { id: 'last', kind: 'transform', fields: {} },
    ],
  }).steps;
  const at = outputs => nextStep(steps, new Map(outputs))?.step.id ?? null;
  const chose = (matched, ran, skipped) => ({ matched, ran, skipped });
  assert.equal(at([]), 'check');
  assert.equal(at([['check', chose(true, ['inner'], ['other'])]]), 'inner');
  assert.equal(
    at([
      ['check', chose(true, ['inner'], ['other'])],
      ['inner', chose(false, [], ['deep'])],
    ]),
    'last',
  );
  assert.equal(
    at([['check', chose(false, ['other'], ['inner'])]]),
    'other',
    'the steps of a skipped condition are skipped too',
  );
  assert.equal(nextStep(steps, new Map([['check', chose(false, ['other'], ['inner'])]])).index, 3);
  assert.equal(
    at([
      ['check', chose(false, ['other'], ['inner'])],
      ['other', {}],
      ['last', {}],
    ]),
    null,
  );
  assert.deepEqual(runCondition(steps[0], {}, new Map()), { matched: true, ran: ['inner'], skipped: ['other'] });
});
