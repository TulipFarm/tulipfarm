import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { inferWithTools } from '../src/inference.ts';
import {
  azureStreamReply,
  isCompletionRequest,
  nativeReply,
  nativeRoutes,
  offeredTools,
  selectReply,
  toolResults,
  use,
} from './native-fixture.mjs';

const draft = {
  title: 'Launch checklist',
  execution: 'plan-only',
  tasks: [
    { key: 'prepare', title: 'Prepare the release' },
    { key: 'review', title: 'Review the release' },
    { key: 'publish', title: 'Publish the release' },
  ],
};

for (const [model, planning] of [
  ['grok-4.3', true],
  ['Kimi-K2.6', true],
  ['grok-4.3', false],
])
  test(`${model} ${planning ? 'Planning' : 'Default'} offers native draft tools on every fresh turn`, async t => {
    const executed = [];
    let round = 0;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const body = JSON.parse(init.body);
      if (isCompletionRequest(body))
        return Response.json(selectReply('azure', { status: 'completed', reason: 'The draft has a tool receipt.' }));
      const names = offeredTools('azure', body).map(tool => tool.name);
      assert.ok(names.includes('plans_create'));
      for (const name of ['plans_read', 'plans_update', 'plans_claim', 'plans_report', 'plans_start'])
        assert.equal(names.includes(name), planning, name);
      const reply =
        round++ % 2 === 0
          ? { calls: [use('plans.create', draft, 'Saving your plan draft')] }
          : { text: 'Your plan draft is ready. No work has started.' };
      return azureStreamReply(nativeReply('azure', reply));
    });
    for (let run = 0; run < 5; run++) {
      const result = await inferWithTools(
        { ...nativeRoutes.azure, model },
        [{ role: 'user', text: 'Create a plan-only draft named Launch checklist with Prepare, Review, Publish.' }],
        async call => {
          executed.push(call.tool);
          assert.equal(call.tool, 'plans.create', 'plan creation must not use HTTP or helper agents');
          assert.equal(call.execution, 'plan-only');
          assert.equal(call.title, draft.title);
          assert.deepEqual(
            call.tasks.map(({ key, title }) => ({ key, title })),
            draft.tasks,
          );
          return { planId: randomUUID(), version: 0, added: draft.tasks.map(task => task.key) };
        },
        undefined,
        false,
        null,
        { builtinSkills: planning ? ['planning'] : [] },
      );
      assert.equal(result.text, 'Your plan draft is ready. No work has started.');
    }
    assert.deepEqual(executed, Array(5).fill('plans.create'));
    assert.equal(round, 10);
  });

for (const model of ['grok-4.3', 'Kimi-K2.6'])
  test(`${model} receives the real planning failure without an invented receipt or HTTP fallback`, async t => {
    let round = 0;
    const executed = [];
    const failure = { error: 'plan-open', instruction: 'Continue the existing plan instead of creating another.' };
    const text = 'This chat already has an open plan. Continue that plan instead.';
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const body = JSON.parse(init.body);
      if (isCompletionRequest(body))
        return Response.json(selectReply('azure', { status: 'blocked', reason: 'A plan is already open.' }));
      assert.ok(offeredTools('azure', body).some(tool => tool.name === 'plans_create'));
      if (round++ === 0) return Response.json(nativeReply('azure', { calls: [use('plans.create', draft)] }));
      assert.ok(round <= 2, 'a real failure does not need repeated planning or generic tool calls');
      assert.ok(toolResults('azure', body).some(result => result.output.includes('plan-open')));
      return Response.json(nativeReply('azure', { text }));
    });
    const result = await inferWithTools(
      { ...nativeRoutes.azure, model },
      [{ role: 'user', text: 'Save a plan-only Launch checklist draft with three steps.' }],
      async call => {
        executed.push(call.tool);
        assert.equal(call.tool, 'plans.create');
        return failure;
      },
      undefined,
      false,
      null,
      { builtinSkills: ['planning'] },
    );
    assert.equal(result.text, text);
    assert.deepEqual(executed, ['plans.create']);
  });
