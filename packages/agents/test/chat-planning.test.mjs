import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { inferWithTools } from '../src/inference.ts';
import { buildInitialPlan, createPlanSchema, PlanGraphError, validatePlanning } from '../src/plan-contracts.ts';
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
  planning: {
    requirements: [
      {
        key: 'launch',
        description: 'Prepare, review and publish the release',
        tasks: ['prepare', 'review', 'publish'],
      },
    ],
  },
};

for (const model of ['grok-4.3', 'Kimi-K2.6'])
  for (const planning of [true, false])
    for (const streaming of [false, true])
      test(`${model} ${planning ? 'Planning' : 'Default'} ${streaming ? 'SSE' : 'JSON'} saves five structured drafts`, async t => {
        const executed = [];
        let round = 0;
        t.mock.method(globalThis, 'fetch', async (_url, init) => {
          const body = JSON.parse(init.body);
          if (isCompletionRequest(body))
            return Response.json(
              selectReply('azure', {
                status: 'completed',
                reason: 'The draft has a tool receipt.',
                planSavedClaim: true,
              }),
            );
          const names = offeredTools('azure', body).map(tool => tool.name);
          assert.ok(names.includes('plans_create'));
          for (const name of ['plans_read', 'plans_update', 'plans_claim', 'plans_report', 'plans_start'])
            assert.equal(names.includes(name), planning, name);
          const reply =
            round++ % 2 === 0
              ? { calls: [use('plans.create', draft, 'Saving your plan draft')] }
              : { text: 'Your plan draft is ready. No work has started.' };
          return streaming ? azureStreamReply(nativeReply('azure', reply)) : Response.json(nativeReply('azure', reply));
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
              const { tool: _tool, ...input } = call;
              const built = buildInitialPlan(createPlanSchema.parse(input));
              assert.doesNotThrow(() => validatePlanning(built.nodes, built.planning));
              assert.deepEqual(
                built.nodes.slice(0, 3).map(task => task.criteria),
                draft.tasks.map(task => [task.title]),
              );
              assert.ok(built.nodes.every(task => task.assignee.kind === 'coordinator'));
              assert.equal(built.nodes.length, 4);
              return { planId: randomUUID(), version: 0, added: built.added };
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

test('a requirement mapping error can be corrected in one retry', async t => {
  let round = 0;
  let executions = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isCompletionRequest(body))
      return Response.json(
        selectReply('azure', {
          status: 'completed',
          reason: 'The corrected draft has a receipt.',
          planSavedClaim: true,
        }),
      );
    if (round === 1) {
      const failures = toolResults('azure', body)
        .map(result => result.output)
        .join('\n');
      assert.match(failures, /"path":\["planning","requirements",0,"tasks"\]/);
      assert.match(failures, /deliverable work keys: prepare, review, publish/);
    }
    assert.ok(round < 3, 'one correction is enough');
    const next = round++;
    return Response.json(
      nativeReply(
        'azure',
        next < 2
          ? {
              calls: [
                use(
                  'plans.create',
                  next === 0
                    ? {
                        ...draft,
                        planning: {
                          requirements: [{ key: 'launch', description: 'Prepare release', tasks: ['wrong-key'] }],
                        },
                      }
                    : draft,
                ),
              ],
            }
          : { text: 'Your plan draft is ready. No work has started.' },
      ),
    );
  });
  const result = await inferWithTools(
    { ...nativeRoutes.azure, model: 'grok-4.3' },
    [{ role: 'user', text: 'Save a plan-only release draft.' }],
    async ({ tool: _tool, ...input }) => {
      executions++;
      try {
        const built = buildInitialPlan(createPlanSchema.parse(input));
        return { planId: randomUUID(), version: 0, added: built.added };
      } catch (error) {
        if (!(error instanceof PlanGraphError)) throw error;
        return { error: error.code, path: error.path, instruction: `Nothing changed. ${error.instruction}` };
      }
    },
    undefined,
    false,
    null,
    { builtinSkills: ['planning'] },
  );
  assert.equal(result.text, 'Your plan draft is ready. No work has started.');
  assert.equal(executions, 2);
});

test('an unbacked saved-plan claim gets a repair round before stopping', async t => {
  let round = 0;
  let executions = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isCompletionRequest(body))
      return Response.json(
        selectReply('azure', {
          status: 'completed',
          reason: 'The candidate says the draft was saved.',
          planSavedClaim: true,
        }),
      );
    const replies = [
      { calls: [use('plans.create', draft)] },
      { text: 'Your plan is saved.' },
      { calls: [use('plans.create', { ...draft, brief: 'Prepare and review the release.' })] },
      { text: 'Your plan draft is ready. No work has started.' },
    ];
    assert.ok(round < replies.length, 'creation repair stays bounded');
    if (round === 2) {
      assert.ok(
        body.messages.some(message => message.role === 'tool' && message.content.includes('planning-coverage')),
      );
    }
    return Response.json(nativeReply('azure', replies[round++]));
  });
  const result = await inferWithTools(
    { ...nativeRoutes.azure, model: 'grok-4.3' },
    [{ role: 'user', text: 'Save a plan-only release draft.' }],
    async () =>
      ++executions === 1
        ? {
            error: 'planning-coverage',
            path: ['planning', 'requirements', 0, 'tasks'],
            instruction: 'Use only deliverable task keys.',
          }
        : { planId: randomUUID(), version: 0, added: ['prepare', 'review', 'publish'] },
    undefined,
    false,
    null,
    { builtinSkills: ['planning'] },
  );
  assert.equal(result.text, 'Your plan draft is ready. No work has started.');
  assert.equal(executions, 2);
  assert.equal(round, 4);
});

for (const error of ['planning-coverage', 'access-denied'])
  test(`unbacked saved-plan claims stop only after correction retries are exhausted: ${error}`, async t => {
    let round = 0;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const body = JSON.parse(init.body);
      if (isCompletionRequest(body))
        return Response.json(
          selectReply('azure', {
            status: 'completed',
            reason: 'The candidate reports a saved draft.',
            planSavedClaim: true,
          }),
        );
      assert.ok(round < 4, 'completion recovery stays bounded');
      return Response.json(
        nativeReply(
          'azure',
          round++ === 0
            ? { calls: [use('plans.create', draft)] }
            : { text: 'Your plan is now saved as a draft. No work has started.' },
        ),
      );
    });
    const result = await inferWithTools(
      { ...nativeRoutes.azure, model: 'grok-4.3' },
      [{ role: 'user', text: 'Save a plan-only release draft.' }],
      async () => ({ error, instruction: 'Nothing changed.' }),
      undefined,
      false,
      null,
      { builtinSkills: ['planning'] },
    );
    assert.equal(
      result.text,
      'I stopped before finishing this request. Check Tool activity for what ran, then ask me to continue.',
    );
    assert.equal(round, 4, 'the model receives both available correction rounds before stopping');
  });

test('a failed completion check cannot approve a plan creation failure', async t => {
  let round = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isCompletionRequest(body))
      return Response.json(selectReply('azure', { status: 'invalid', reason: 'Unreadable verdict.' }));
    return Response.json(
      nativeReply('azure', round++ === 0 ? { calls: [use('plans.create', draft)] } : { text: 'Your plan is saved.' }),
    );
  });
  const result = await inferWithTools(
    { ...nativeRoutes.azure, model: 'grok-4.3' },
    [{ role: 'user', text: 'Save a plan-only release draft.' }],
    async () => ({ error: 'planning-coverage' }),
    undefined,
    false,
    null,
    { builtinSkills: ['planning'] },
  );
  assert.equal(
    result.text,
    'I stopped before finishing this request. Check Tool activity for what ran, then ask me to continue.',
  );
});

for (const text of [
  'The workspace does not allow saving a new plan.',
  'Plan mode blocks saving this plan-only draft.',
  'Your plan is now saved as a draft.',
])
  test(`exhausted planning validation never sends a model-invented explanation: ${text}`, async t => {
    let round = 0;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const body = JSON.parse(init.body);
      if (isCompletionRequest(body))
        return Response.json(selectReply('azure', { status: 'blocked', reason: 'The candidate states a blocker.' }));
      return Response.json(
        nativeReply(
          'azure',
          round++ < 3
            ? {
                calls: [
                  use('plans.create', {
                    ...draft,
                    tasks: [{ key: `invalid key ${round}`, title: 'Prepare release' }],
                  }),
                ],
              }
            : { text },
        ),
      );
    });
    const result = await inferWithTools(
      { ...nativeRoutes.azure, model: 'grok-4.3' },
      [{ role: 'user', text: 'Save a plan-only release draft.' }],
      async () => assert.fail('invalid arguments must not execute'),
      undefined,
      false,
      null,
      { builtinSkills: ['planning'] },
    );
    assert.equal(
      result.text,
      'I stopped before finishing this request. Check Tool activity for what ran, then ask me to continue.',
    );
    assert.equal(round, 3, 'no explanation is requested after validation retries are exhausted');
  });
