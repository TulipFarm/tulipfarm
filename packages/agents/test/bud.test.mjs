import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferWithTools } from '../src/inference.ts';
import { formats, nativeRoutes, nativeReply, completionReply, isCompletionRequest } from './native-fixture.mjs';

for (const provider of formats)
  test(`${provider}: Bud expressions reach the stream and latest reply metadata, never business dispatch`, async t => {
    const route = nativeRoutes[provider],
      requests = [],
      updates = [];
    const replies = ['Solving', 'Celebrating'].map(state =>
      nativeReply(provider, { calls: [{ name: 'bud_state', input: { name: 'Bud', state } }] }),
    );
    replies.push(nativeReply(provider, { text: 'The answer is 42.' }));
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      const body = JSON.parse(options.body);
      if (isCompletionRequest(body)) return Response.json(completionReply(provider));
      requests.push(body);
      return Response.json(replies.shift());
    });
    const result = await inferWithTools(
      route,
      [{ role: 'user', text: 'Solve this.' }],
      () => assert.fail('Expression must not dispatch business tools'),
      undefined,
      false,
      null,
      { avatar: { update: value => updates.push(value) } },
    );
    assert.deepEqual(result, { text: 'The answer is 42.', avatar: { name: 'Bud', state: 'Celebrating' } });
    assert.deepEqual(
      updates.map(update => update.avatar.state),
      ['Thinking', 'Solving', 'Celebrating'],
    );
    assert.match(JSON.stringify(requests[0]), /bud_state/);
    assert.match(JSON.stringify(requests[1]), /Solving/);
    assert.match(JSON.stringify(requests[0]), /Bud/);
  });

test('invalid state is corrected, and omitted state leaves ordinary reply text intact', async t => {
  const replies = [
    nativeReply('anthropic', { calls: [{ name: 'bud_state', input: { name: 'Other', state: 'Invented' } }] }),
    nativeReply('anthropic', { text: 'Hello.' }),
  ];
  const updates = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) =>
    Response.json(isCompletionRequest(JSON.parse(options.body)) ? completionReply('anthropic') : replies.shift()),
  );
  const result = await inferWithTools(nativeRoutes.anthropic, [], () => assert.fail(), undefined, false, null, {
    avatar: { update: value => updates.push(value) },
  });
  assert.deepEqual(result, { text: 'Hello.', avatar: { name: 'Bud', state: 'Idle' } });
  assert.deepEqual(
    updates.map(update => update.avatar.state),
    ['Thinking', 'Idle'],
  );
});

for (const provider of formats)
  test(`${provider}: with Bud off, a greeting is one model round and the request has no avatar tool or instructions`, async t => {
    const route = nativeRoutes[provider],
      requests = [],
      checks = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      const body = JSON.parse(options.body);
      if (isCompletionRequest(body)) {
        checks.push(requests.length);
        return Response.json(completionReply(provider));
      }
      requests.push(options.body);
      return Response.json(nativeReply(provider, { text: 'Hi! How can I help?' }));
    });
    const result = await inferWithTools(route, [{ role: 'user', text: 'hey' }], () => assert.fail());
    assert.deepEqual(result, { text: 'Hi! How can I help?' });
    assert.equal(requests.length, 1);
    assert.deepEqual(checks, [1], 'the completion check follows the single reply round');
    for (const pattern of [/bud_state/, /avatar/i, /expression/i, /Waving/, /\bBud\b.*\bIdle\b/])
      assert.doesNotMatch(requests[0], pattern);
  });

test('with Bud off, a stray avatar-only call never costs a model round', async t => {
  let requests = 0;
  const replies = [
    nativeReply('anthropic', {
      text: 'Hello!',
      calls: [{ name: 'bud_state', input: { name: 'Bud', state: 'Waving' } }],
    }),
  ];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (isCompletionRequest(JSON.parse(options.body))) return Response.json(completionReply('anthropic'));
    requests++;
    return Response.json(replies.shift());
  });
  assert.deepEqual(await inferWithTools(nativeRoutes.anthropic, [], () => assert.fail()), { text: 'Hello!' });
  assert.equal(requests, 1);
});

test('expression-only loops are bounded and do not execute business actions', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return Response.json(
      nativeReply('anthropic', { calls: [{ name: 'bud_state', input: { name: 'Bud', state: 'Waving' } }] }),
    );
  });
  await assert.rejects(
    inferWithTools(nativeRoutes.anthropic, [], () => assert.fail(), undefined, false, null, {
      avatar: { update() {} },
    }),
    /model-invalid-decision/,
  );
  assert.equal(requests, 9);
});

test('Bud metadata does not bypass completion checks or idle before a rejected answer is corrected', async t => {
  const updates = [],
    candidates = [];
  const replies = [
    nativeReply('anthropic', { text: 'I will calculate it.' }),
    nativeReply('anthropic', { calls: [{ name: 'bud_state', input: { name: 'Bud', state: 'Solving' } }] }),
    nativeReply('anthropic', { text: '18 times 24 is 432.' }),
  ];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    if (isCompletionRequest(body)) {
      candidates.push(body);
      return Response.json(completionReply('anthropic', candidates.length === 1 ? 'continue' : 'completed'));
    }
    return Response.json(replies.shift());
  });
  const result = await inferWithTools(
    nativeRoutes.anthropic,
    [{ role: 'user', text: 'What is 18 times 24?' }],
    () => assert.fail(),
    undefined,
    false,
    null,
    { avatar: { update: value => updates.push(value) } },
  );
  assert.deepEqual(result, { text: '18 times 24 is 432.', avatar: { name: 'Bud', state: 'Solving' } });
  assert.deepEqual(
    updates.map(update => update.avatar.state),
    ['Thinking', 'Solving'],
  );
  assert.equal(candidates.length, 2);
  assert.equal(replies.length, 0);
});
