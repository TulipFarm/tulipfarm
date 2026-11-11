import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { inferWithTools } from '../src/inference.ts';
import * as ownService from '../src/own-service.ts';
import { discoverToolNames } from '../src/tools.ts';
import {
  completionReply,
  isCompletionRequest,
  nativeReply,
  nativeRoutes,
  offeredTools,
  toolResults,
  useCall,
} from './native-fixture.mjs';

function configureOrigin(t) {
  const previous = process.env.WEB_ORIGIN;
  process.env.WEB_ORIGIN = 'https://app.tulipfarm.ai';
  t.after(() => {
    if (previous === undefined) delete process.env.WEB_ORIGIN;
    else process.env.WEB_ORIGIN = previous;
  });
}

const requests = [
  {
    family: 'plans',
    text: 'Save a plan-only Launch draft with one Prepare step.',
    call: {
      tool: 'plans.create',
      title: 'Launch',
      execution: 'plan-only',
      tasks: [{ key: 'prepare', title: 'Prepare' }],
    },
    receipt: { planId: randomUUID(), version: 0, added: ['prepare'] },
  },
  {
    family: 'knowledge',
    text: 'Prepare a Knowledge note titled Launch with the text Prepare.',
    call: { tool: 'knowledge.add', title: 'Launch', text: 'Prepare' },
    receipt: { id: randomUUID(), status: 'pending', kind: 'add' },
  },
  {
    family: 'projects',
    text: 'List my projects.',
    call: { tool: 'projects.list' },
    receipt: { projects: [] },
  },
];

for (const model of ['grok-4.3', 'Kimi-K2.6'])
  for (const request of requests)
    test(`${model} recovers an own-service ${request.family} refusal through admitted native tools`, async t => {
      configureOrigin(t);
      let round = 0;
      const executed = [];
      const failure = structuredClone(ownService.ownServiceRefusal);
      const api = { tool: 'api.request', method: 'GET', url: `https://api.tulipfarm.ai/v1/${request.family}` };
      t.mock.method(globalThis, 'fetch', async (_url, init) => {
        const body = JSON.parse(init.body);
        if (isCompletionRequest(body)) return Response.json(completionReply('azure'));
        const replies = [
          { calls: [useCall(api)] },
          ...(request.family === 'plans'
            ? []
            : [{ calls: [{ name: 'tools_search', input: { query: request.call.tool } }] }]),
          { calls: [useCall(request.call)] },
          { text: 'Done.' },
        ];
        assert.ok(round < replies.length, 'recovery does not need another API call');
        if (round === 1) {
          const output = toolResults('azure', body)[0].output;
          assert.match(output, /Available built-in tools:/);
          assert.ok(output.includes(request.call.tool.replaceAll('.', '_')));
          assert.match(output, /Call tools_search/);
          assert.equal(output.split('Available built-in tools:').length, 2);
        }
        if (round === (request.family === 'plans' ? 1 : 2))
          assert.ok(offeredTools('azure', body).some(tool => tool.name === request.call.tool.replaceAll('.', '_')));
        return Response.json(nativeReply('azure', replies[round++]));
      });
      const result = await inferWithTools(
        { ...nativeRoutes.azure, model },
        [{ role: 'user', text: request.text }],
        async call => {
          executed.push(call.tool);
          return call.tool === 'api.request' ? failure : request.receipt;
        },
      );
      assert.equal(result.text, 'Done.');
      assert.deepEqual(executed, ['api.request', request.call.tool]);
      assert.deepEqual(failure, ownService.ownServiceRefusal, 'model guidance never mutates the visible refusal');
    });

test('own-service corrections use only admitted tools, cap the list and ignore unknown URL families', () => {
  const names = discoverToolNames({ kind: 'chat' });
  const correction = ownService.ownServiceCorrection;
  assert.equal(typeof correction, 'function');
  const limited = correction('https://api.tulipfarm.ai/api/v1/projects', ['api.request', 'projects.read']);
  assert.match(limited, /projects_read/);
  assert.doesNotMatch(limited, /projects_list|projects_draft/);
  const full = correction('https://api.tulipfarm.ai/v1/rows', names);
  const listed = full.split('Available built-in tools: ')[1].split('. Call tools_search')[0].split(', ');
  assert.equal(listed.length, 8);
  assert.ok(listed.every(name => names.some(tool => tool.replaceAll('.', '_') === name)));
  for (const url of [
    'https://api.tulipfarm.ai/v1/unknown?projects=list',
    'https://api.tulipfarm.ai/api/v1/unknown',
    'https://api.tulipfarm.ai/v1/projects-unavailable',
    'not a URL',
  ])
    assert.equal(correction(url, names), undefined);
  assert.equal(correction('https://api.tulipfarm.ai/v1/plans', []), undefined);
});

test('a repeated own-service refusal stops without stacking model-only guidance', async t => {
  configureOrigin(t);
  let rounds = 0;
  let executed = 0;
  const call = { tool: 'api.request', method: 'GET', url: 'https://api.tulipfarm.ai/v1/plans' };
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    if (rounds === 1) {
      const output = toolResults('azure', body)[0].output;
      assert.equal(output.split('Available built-in tools:').length, 2);
    }
    assert.ok(++rounds <= 2);
    return Response.json(nativeReply('azure', { calls: [useCall(call)] }));
  });
  const result = await inferWithTools(
    { ...nativeRoutes.azure, model: 'grok-4.3' },
    [{ role: 'user', text: 'Read my plan.' }],
    async () => {
      executed++;
      return ownService.ownServiceRefusal;
    },
  );
  assert.equal(executed, 1);
  assert.equal(rounds, 2);
  assert.equal(
    result.text,
    'Nothing was sent. This same call was already refused. Use a different allowed address or the built-in tools instead.',
  );
  assert.doesNotMatch(result.text, /plans_create|tools_search|Available built-in tools/);
});
