import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics';
import { inferDecision, inferText, inferWithSystem, inferWithTools } from '../dist/inference.js';
import { readModelResponse } from '../dist/inference-stream.js';
import { calendarTextRecovery } from '../dist/calendar-text-check.js';
import { withChatMeasurements } from '../../observability/dist/index.js';
import {
  completionReply,
  isCompletionRequest,
  formats,
  nativeReply,
  nativeRoutes,
  selectReply,
  useCall,
} from './native-fixture.mjs';

const messages = [{ role: 'user', text: 'PRIVATE PROMPT' }];
const input = {
  prompt: 'PRIVATE PROMPT',
  definition: { name: 'Synthetic agent', instructions: 'Select one bounded decision.', tools: [] },
  scope: [],
  task: true,
};
const answer = { kind: 'answer', text: 'PRIVATE ANSWER' };
const encoder = new TextEncoder();
const encodeEvent = event => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
const streamResponse = events =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(encodeEvent(event));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );

test('provider inference telemetry covers body consumption, usage, returned errors, and secondary calls without private data', async t => {
  const spans = new InMemorySpanExporter();
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 60000 });
  const sdk = new NodeSDK({
    autoDetectResources: false,
    spanProcessors: [new SimpleSpanProcessor(spans)],
    metricReader: reader,
  });
  sdk.start();
  const finished = () => spans.getFinishedSpans();
  const noTools = () => assert.fail('No tool expected');
  try {
    for (const format of formats)
      await t.test(`${format} reports cache-inclusive task and chat usage, with no nonstream TTFT`, async t => {
        let reply;
        t.mock.method(globalThis, 'fetch', async (_url, init) =>
          Response.json(isCompletionRequest(JSON.parse(init.body)) ? completionReply(format) : reply),
        );
        reply = nativeReply(format, { text: answer.text });
        assert.equal((await inferDecision(nativeRoutes[format], input)).kind, 'success');
        reply = nativeReply(format, { text: answer.text });
        assert.equal(await inferText(nativeRoutes[format], messages), answer.text);
        assert.equal(await inferWithSystem(nativeRoutes[format], 'PRIVATE SYSTEM', messages), answer.text);
        assert.deepEqual(await inferWithTools(nativeRoutes[format], messages, noTools), { text: answer.text });
        for (const span of finished().slice(-5)) {
          assert.equal(span.attributes['gen_ai.provider.name'], nativeRoutes[format].provider);
          assert.equal(span.attributes['gen_ai.request.model'], nativeRoutes[format].model);
          assert.equal(span.attributes['gen_ai.usage.input_tokens'], 13);
          assert.equal(span.attributes['gen_ai.usage.output_tokens'], 7);
          assert.equal(span.attributes.outcome, 'success');
        }
      });
    await t.test('Anthropic aggregates both cache TTLs and legacy cache writes', async t => {
      const reply = structuredClone(nativeReply('anthropic', { text: answer.text }));
      t.mock.method(globalThis, 'fetch', async () => Response.json(reply));
      reply.usage.cache_creation_input_tokens = 7;
      reply.usage.cache_creation = { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 5 };
      await inferText(nativeRoutes.anthropic, messages);
      assert.equal(finished().at(-1).attributes['gen_ai.usage.input_tokens'], 20);
      delete reply.usage.cache_creation;
      await inferWithSystem(nativeRoutes.anthropic, 'PRIVATE SYSTEM', messages);
      assert.equal(finished().at(-1).attributes['gen_ai.usage.input_tokens'], 20);
    });
    await t.test('configuration and admission failures occur before inference spans', async t => {
      t.mock.method(globalThis, 'fetch', noTools);
      const count = finished().length;
      assert.equal(
        (await inferDecision({ ...nativeRoutes.azure, endpoint: 'https://example.com/' }, input)).reason,
        'configuration',
      );
      assert.equal((await inferDecision(nativeRoutes.azure, { ...input, prompt: '' })).reason, 'invalid-request');
      assert.equal((await inferDecision(nativeRoutes.azure, input, AbortSignal.abort())).reason, 'cancelled');
      await assert.rejects(inferText({ ...nativeRoutes.azure, endpoint: 'https://example.com/' }, messages), {
        message: 'model-request-not-dispatched',
      });
      await assert.rejects(
        inferWithTools({ ...nativeRoutes.azure, endpoint: 'https://example.com/' }, messages, noTools),
      );
      const denied = new Error('credit-limit');
      await assert.rejects(
        inferWithSystem(nativeRoutes.azure, 'system', messages, async () => {
          throw denied;
        }),
        error => error === denied,
      );
      assert.equal(finished().length, count);
    });
    await t.test('returned task failures keep their result and error status, including known usage', async t => {
      let reply = nativeReply('azure', { text: answer.text });
      let status = 429;
      t.mock.method(globalThis, 'fetch', async () => Response.json(reply, { status }));
      let result = await inferDecision(nativeRoutes.azure, input);
      assert.equal(result.reason, 'quota');
      assert.equal(result.status, 429);
      assert.equal(result.usage.kind, 'known');
      assert.equal(finished().at(-1).status.code, 2);
      assert.equal(finished().at(-1).attributes['gen_ai.usage.input_tokens'], 13);
      status = 200;
      reply = { ...reply, choices: [] };
      result = await inferDecision(nativeRoutes.azure, input);
      assert.equal(result.reason, 'invalid-decision');
      assert.equal(finished().at(-1).attributes.outcome, 'error');
      t.mock.method(globalThis, 'fetch', async () => {
        throw new TypeError('PRIVATE TRANSPORT');
      });
      result = await inferDecision(nativeRoutes.azure, input);
      assert.equal(result.reason, 'transport');
      assert.equal(finished().at(-1).attributes.outcome, 'error');
      assert.equal(finished().at(-1).attributes['gen_ai.usage.input_tokens'], undefined);
    });
    await t.test('thrown errors are unchanged and usage is recorded before meter failure', async t => {
      const error = new Error('PRIVATE TRANSPORT');
      t.mock.method(globalThis, 'fetch', async () => {
        throw error;
      });
      await assert.rejects(inferText(nativeRoutes.azure, messages), actual => actual === error);
      assert.equal(finished().at(-1).attributes.outcome, 'error');
      t.mock.method(globalThis, 'fetch', async () => Response.json(nativeReply('azure', { text: answer.text })));
      await assert.rejects(
        inferText(nativeRoutes.azure, messages, async () => {
          throw error;
        }),
        actual => actual === error,
      );
      assert.equal(finished().at(-1).attributes['gen_ai.usage.input_tokens'], 13);
      t.mock.method(globalThis, 'fetch', async () =>
        Response.json({ choices: [{ message: { content: answer.text } }] }),
      );
      assert.equal(await inferText(nativeRoutes.azure, messages), answer.text);
      assert.equal(finished().at(-1).attributes['gen_ai.usage.input_tokens'], undefined);
    });
    for (const [name, complete] of [
      ['inferText', (route, onUsage) => inferText(route, messages, onUsage)],
      ['inferWithSystem', (route, onUsage) => inferWithSystem(route, 'PRIVATE SYSTEM', messages, async () => onUsage)],
    ])
      for (const [format, status, text, error] of [
        ['anthropic', 'refusal', ''],
        ['anthropic', 'max_tokens', answer.text],
        ['azure', 'refusal', ''],
        ['azure', 'content_filter', ''],
        ['azure', 'length', answer.text],
        ['google', 'SAFETY', ''],
        ['google', 'MAX_TOKENS', answer.text],
        ['responses', 'refusal', ''],
        ['responses', 'max_output_tokens', answer.text, 'model-invalid-response'],
      ])
        await t.test(
          `${name} HTTP-200 ${format} ${status} flags an error without changing returned text or errors`,
          async t => {
            const reply = structuredClone(nativeReply(format, { text }));
            if (format === 'anthropic') reply.stop_reason = status;
            else if (format === 'azure') {
              if (status === 'refusal') reply.choices[0].message.refusal = 'PRIVATE REFUSAL';
              else reply.choices[0].finish_reason = status;
            } else if (format === 'google') reply.candidates[0].finishReason = status;
            else if (status === 'refusal')
              reply.output.push({ type: 'message', content: [{ type: 'refusal', refusal: 'PRIVATE REFUSAL' }] });
            else {
              reply.status = 'incomplete';
              reply.incomplete_details = { reason: status };
            }
            t.mock.method(globalThis, 'fetch', async () => Response.json(reply));
            const settled = [];
            const result = complete(nativeRoutes[format], async usage => {
              settled.push(usage);
            });
            if (error) await assert.rejects(result, { message: error });
            else assert.equal(await result, text);
            assert.equal(settled.length, 1);
            assert.equal(settled[0].kind, 'known');
            assert.equal(finished().at(-1).attributes.outcome, 'error');
            assert.equal(finished().at(-1).status.code, 2);
            assert.equal(finished().at(-1).attributes['gen_ai.usage.input_tokens'], 13);
            assert.equal(finished().at(-1).attributes['gen_ai.usage.output_tokens'], 7);
          },
        );
    await t.test('nonstream spans include delayed body parsing but do not invent a first token', async t => {
      let deliver;
      const body = new Promise(resolve => {
        deliver = resolve;
      });
      let fetched;
      const dispatched = new Promise(resolve => {
        fetched = resolve;
      });
      t.mock.method(globalThis, 'fetch', async () => {
        fetched();
        return { ok: true, status: 200, headers: new Headers(), json: () => body };
      });
      const count = finished().length;
      const pending = inferWithSystem(nativeRoutes.azure, 'PRIVATE SYSTEM', messages);
      await dispatched;
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(finished().length, count);
      deliver(nativeReply('azure', { text: answer.text }));
      assert.equal(await pending, answer.text);
      assert.equal(finished().length, count + 1);
      assert.equal(finished().at(-1).attributes['gen_ai.usage.input_tokens'], 13);
    });
    await t.test('calendar checks and title generation each have their own provider span', async t => {
      const call = {
        tool: 'google.propose',
        operation: { kind: 'calendar.calendars.create', calendar: { summary: 'QA.' } },
      };
      const source = {
        summary: { mode: 'literal', source: { message: 0, text: 'QA.' } },
        description: { mode: 'unspecified' },
      };
      const replies = [
        nativeReply('azure', { calls: [useCall(call)] }),
        selectReply('azure', source),
        nativeReply('azure', { text: 'Ready.' }),
        completionReply('azure'),
        nativeReply('anthropic', { text: 'Calendar title' }),
      ];
      t.mock.method(globalThis, 'fetch', async () => Response.json(replies.shift()));
      const count = finished().length;
      assert.deepEqual(
        await inferWithTools(
          nativeRoutes.azure,
          [{ role: 'user', text: 'Create calendar "QA."' }],
          async () => ({ id: 'review' }),
          undefined,
          true,
          null,
          { titleRoute: nativeRoutes.anthropic },
        ),
        { text: 'Ready.', title: 'Calendar title' },
      );
      assert.equal(finished().length, count + 5);
      assert.equal(finished().at(-1).attributes['gen_ai.provider.name'], 'anthropic');
      assert.equal(finished().at(-1).attributes['gen_ai.usage.input_tokens'], 13);
    });
    for (const [format, status, reason] of [
      ['anthropic', 'refusal', 'refusal'],
      ['anthropic', 'max_tokens', 'output-limit'],
      ['azure', 'content_filter', 'refusal'],
      ['azure', 'length', 'output-limit'],
      ['google', 'SAFETY', 'refusal'],
      ['google', 'MAX_TOKENS', 'output-limit'],
      ['responses', 'content_filter', 'refusal'],
      ['responses', 'max_output_tokens', 'output-limit'],
      ['responses', 'failed', 'invalid-decision'],
    ])
      await t.test(`${format} HTTP-200 ${status} records failed outcomes and retains the original error`, async t => {
        const reply = structuredClone(nativeReply(format, { text: answer.text }));
        if (format === 'anthropic') reply.stop_reason = status;
        else if (format === 'azure') reply.choices[0].finish_reason = status;
        else if (format === 'google') reply.candidates[0].finishReason = status;
        else {
          reply.status = status === 'failed' ? 'failed' : 'incomplete';
          if (status !== 'failed') reply.incomplete_details = { reason: status };
        }
        t.mock.method(globalThis, 'fetch', async () =>
          format === 'responses'
            ? streamResponse([{ type: `response.${reply.status}`, response: reply }])
            : Response.json(reply),
        );
        const count = finished().length;
        await assert.rejects(inferWithTools(nativeRoutes[format], messages, noTools), { message: `model-${reason}` });
        const attempts = finished().slice(count);
        assert.equal(attempts.length, status === 'failed' ? 3 : 1);
        for (const span of attempts) {
          assert.equal(span.attributes.outcome, 'error');
          assert.equal(span.status.code, 2);
          assert.equal(span.attributes['gen_ai.usage.input_tokens'], 13);
          assert.equal(span.attributes['gen_ai.usage.output_tokens'], 7);
        }
      });
    await t.test('a returned calendar-check failure marks its span while retaining the recovery response', async t => {
      const call = {
        tool: 'google.propose',
        operation: { kind: 'calendar.calendars.create', calendar: { summary: 'QA.' } },
      };
      const failed = {
        ...nativeReply('responses'),
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      };
      const replies = [
        Response.json(nativeReply('responses', { calls: [useCall(call)] })),
        streamResponse([{ type: 'response.incomplete', response: failed }]),
      ];
      t.mock.method(globalThis, 'fetch', async () => replies.shift());
      assert.deepEqual(
        await inferWithTools(nativeRoutes.responses, [{ role: 'user', text: 'Create calendar "QA."' }], noTools),
        { text: calendarTextRecovery },
      );
      assert.equal(finished().at(-2).attributes.outcome, 'success');
      assert.equal(finished().at(-1).attributes.outcome, 'error');
      assert.equal(finished().at(-1).attributes['gen_ai.usage.input_tokens'], 13);
    });
    await t.test('a truncated title marks an error without changing the existing partial-title result', async t => {
      const truncated = { ...nativeReply('anthropic', { text: 'Partial title' }), stop_reason: 'max_tokens' };
      const replies = [nativeReply('azure', { text: 'Ready.' }), completionReply('azure'), truncated];
      t.mock.method(globalThis, 'fetch', async () => Response.json(replies.shift()));
      assert.deepEqual(
        await inferWithTools(nativeRoutes.azure, messages, noTools, undefined, true, null, {
          titleRoute: nativeRoutes.anthropic,
        }),
        { text: 'Ready.', title: 'Partial title' },
      );
      assert.equal(finished().at(-2).attributes.outcome, 'success');
      assert.equal(finished().at(-1).attributes.outcome, 'error');
      assert.equal(finished().at(-1).attributes['gen_ai.usage.input_tokens'], 13);
    });
    await reader.forceFlush();
    let metrics = metricExporter
      .getMetrics()
      .flatMap(resource => resource.scopeMetrics.flatMap(scope => scope.metrics));
    assert.equal(
      metrics.find(metric => metric.descriptor.name === 'gen_ai_client_time_to_first_token'),
      undefined,
    );
    await t.test(
      'a streaming span stays open until final usage and records a tool-only first token without answerText',
      async t => {
        let controller;
        const reply = nativeReply('azure', { calls: [useCall({ tool: 'web.fetch', url: 'https://example.com/' })] });
        const response = new Response(
          new ReadableStream({
            start(value) {
              controller = value;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
        const replies = [
          response,
          Response.json(nativeReply('azure', { text: 'Ready.' })),
          Response.json(completionReply('azure')),
        ];
        let fetched;
        const dispatched = new Promise(resolve => {
          fetched = resolve;
        });
        t.mock.method(globalThis, 'fetch', async () => {
          fetched();
          return replies.shift();
        });
        const count = finished().length;
        const pending = inferWithTools(nativeRoutes.azure, messages, async () => ({ text: 'page' }));
        await dispatched;
        controller.enqueue(
          encodeEvent({
            model: 'actual-azure',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [{ index: 0, id: 'call_0', function: { name: 'web_fetch', arguments: '' } }],
                },
              },
            ],
          }),
        );
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(finished().length, count);
        await reader.forceFlush();
        const before = metricExporter
          .getMetrics()
          .flatMap(resource => resource.scopeMetrics.flatMap(scope => scope.metrics));
        assert.equal(
          before.find(metric => metric.descriptor.name === 'gen_ai_client_time_to_first_token'),
          undefined,
        );
        controller.enqueue(
          encodeEvent({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, function: { arguments: reply.choices[0].message.tool_calls[0].function.arguments } },
                  ],
                },
              },
            ],
          }),
        );
        controller.enqueue(
          encodeEvent({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: reply.usage }),
        );
        controller.close();
        assert.deepEqual(await pending, { text: 'Ready.' });
        assert.equal(finished().length, count + 3);
        assert.equal(finished().at(-3).attributes['gen_ai.usage.input_tokens'], 13);
      },
    );
    await reader.forceFlush();
    metrics = metricExporter.getMetrics().flatMap(resource => resource.scopeMetrics.flatMap(scope => scope.metrics));
    const ttft = metrics.find(metric => metric.descriptor.name === 'gen_ai_client_time_to_first_token');
    assert.equal(
      ttft.dataPoints.reduce((count, point) => count + point.value.count, 0),
      1,
    );
    const detailLogs = [];
    const write = process.stdout.write.bind(process.stdout);
    t.mock.method(process.stdout, 'write', (chunk, ...args) => {
      if (typeof chunk === 'string' && chunk.startsWith('{"level":')) {
        detailLogs.push(JSON.parse(chunk));
        return true;
      }
      return write(chunk, ...args);
    });
    const gate = () => {
      let release;
      const promise = new Promise(resolve => {
        release = resolve;
      });
      return { promise, release };
    };
    await t.test('chat detail gates separate admission, fetch/body, settlement and local parsing', async t => {
      const admission = gate();
      const reserving = gate();
      const fetching = gate();
      const headers = gate();
      const body = gate();
      const settling = gate();
      const settlement = gate();
      const sent = [];
      t.mock.method(globalThis, 'fetch', async (_url, init) => {
        sent.push(init.body);
        if (sent.length > 1) return Response.json(completionReply('azure'));
        fetching.release();
        await headers.promise;
        return { ok: true, status: 200, headers: new Headers(), json: () => body.promise };
      });
      const count = finished().length;
      const details = phase =>
        finished()
          .slice(count)
          .filter(span => span.name === `chat.detail.${phase}`);
      const pending = withChatMeasurements(() =>
        inferWithTools(nativeRoutes.azure, messages, noTools, async ({ step }) => {
          if (step === 0) {
            reserving.release();
            await admission.promise;
          }
          return async usage => {
            assert.equal(usage.kind, 'known');
            if (step === 0) {
              settling.release();
              await settlement.promise;
            }
          };
        }),
      );
      await reserving.promise;
      assert.equal(sent.length, 0);
      assert.equal(details('reserve').length, 0);
      assert.equal(details('provider').length, 0);
      admission.release();
      await fetching.promise;
      assert.equal(details('reserve').length, 1);
      assert.equal(details('provider').length, 0);
      headers.release();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(details('provider').length, 0);
      body.release(nativeReply('azure', { text: answer.text }));
      await settling.promise;
      assert.equal(details('provider').length, 1);
      assert.equal(details('response-parse').length, 1);
      assert.equal(details('settle').length, 0);
      assert.equal(details('decision-parse').length, 0);
      assert.equal(
        finished()
          .slice(count)
          .filter(span => span.attributes['gen_ai.provider.name'] !== undefined).length,
        0,
      );
      settlement.release();
      assert.deepEqual(await pending, { text: answer.text });
      assert.equal(details('provider').length, 2);
      assert.equal(details('settle').length, 2);
      assert.deepEqual(
        details('request').map(span => [span.attributes['chat.purpose'], span.attributes['chat.request.sequence']]),
        [
          ['reply', 1],
          ['completion', 2],
        ],
      );
      const sizes = detailLogs
        .filter(record => record.operation === 'chat.request-size' && record['chat.request.wire_bytes'] !== undefined)
        .slice(-2);
      assert.deepEqual(
        sizes.map(record => record['chat.request.wire_bytes']),
        sent.map(value => Buffer.byteLength(value)),
      );
    });
    await t.test(
      'detail admission and transport failures preserve errors and never settle undispatched calls',
      async t => {
        const denied = new Error('PRIVATE CREDIT DENIAL');
        t.mock.method(globalThis, 'fetch', noTools);
        let count = finished().length;
        await assert.rejects(
          withChatMeasurements(() =>
            inferWithTools(nativeRoutes.azure, messages, noTools, async () => {
              throw denied;
            }),
          ),
          error => error === denied,
        );
        let details = finished().slice(count);
        assert.equal(details.filter(span => span.name === 'chat.detail.provider').length, 0);
        assert.equal(details.find(span => span.name === 'chat.detail.reserve').attributes.outcome, 'error');
        const transport = new Error('PRIVATE TRANSPORT');
        t.mock.method(globalThis, 'fetch', async () => {
          throw transport;
        });
        count = finished().length;
        await assert.rejects(
          withChatMeasurements(() => inferWithTools(nativeRoutes.azure, messages, noTools, async () => noTools)),
          error => error === transport,
        );
        details = finished().slice(count);
        assert.equal(details.find(span => span.name === 'chat.detail.provider').attributes.outcome, 'error');
        assert.equal(details.filter(span => span.name === 'chat.detail.settle').length, 0);
        t.mock.method(globalThis, 'fetch', async () => Response.json(nativeReply('azure', { text: answer.text })));
        count = finished().length;
        await assert.rejects(
          withChatMeasurements(() =>
            inferWithTools(nativeRoutes.azure, messages, noTools, async () => async () => {
              throw denied;
            }),
          ),
          error => error === denied,
        );
        details = finished().slice(count);
        assert.equal(details.find(span => span.name === 'chat.detail.provider').attributes.outcome, 'success');
        assert.equal(details.find(span => span.name === 'chat.detail.settle').attributes.outcome, 'error');
        assert.equal(details.filter(span => span.name === 'chat.detail.decision-parse').length, 0);
      },
    );
    await t.test(
      'provider detail consumes the complete SSE body before settlement and preserves streamed text',
      async t => {
        let controller;
        const fetched = gate();
        const stopped = new Error('PRIVATE SETTLEMENT FAILURE');
        const previews = [];
        const settled = [];
        t.mock.method(globalThis, 'fetch', async () => {
          fetched.release();
          return new Response(
            new ReadableStream({
              start(value) {
                controller = value;
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        });
        const count = finished().length;
        const pending = withChatMeasurements(() =>
          inferWithTools(
            nativeRoutes.azure,
            messages,
            noTools,
            async () => async usage => {
              settled.push(usage);
              throw stopped;
            },
            false,
            null,
            { answerText: update => previews.push(update) },
          ),
        );
        await fetched.promise;
        controller.enqueue(encodeEvent({ choices: [{ index: 0, delta: { content: answer.text } }] }));
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(previews, [{ step: 0, text: answer.text }]);
        assert.equal(settled.length, 0);
        assert.equal(
          finished()
            .slice(count)
            .filter(span => span.name === 'chat.detail.provider').length,
          0,
        );
        controller.enqueue(
          encodeEvent({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: nativeReply('azure').usage }),
        );
        controller.close();
        await assert.rejects(pending, error => error === stopped);
        assert.equal(settled.length, 1);
        assert.equal(settled[0].kind, 'known');
        const details = finished().slice(count);
        assert.equal(details.find(span => span.name === 'chat.detail.provider').attributes.outcome, 'success');
        assert.equal(details.find(span => span.name === 'chat.detail.settle').attributes.outcome, 'error');
      },
    );
    await t.test('HTTP failures and malformed bodies retain their original settlement behavior', async t => {
      const settled = [];
      const reply = nativeReply('azure', { text: answer.text });
      const start = finished().length;
      t.mock.method(globalThis, 'fetch', async () => Response.json(reply, { status: 429 }));
      await assert.rejects(
        withChatMeasurements(() =>
          inferWithTools(nativeRoutes.azure, messages, noTools, async () => async usage => {
            settled.push(usage);
          }),
        ),
        { message: 'model-quota' },
      );
      assert.equal(settled.length, 1);
      assert.equal(settled[0].kind, 'known');
      t.mock.method(
        globalThis,
        'fetch',
        async () => new Response('{', { headers: { 'content-type': 'application/json' } }),
      );
      await assert.rejects(
        withChatMeasurements(() =>
          inferWithTools(nativeRoutes.azure, messages, noTools, async () => async usage => {
            settled.push(usage);
          }),
        ),
        { message: 'model-invalid-decision' },
      );
      assert.deepEqual(settled.slice(1), [{ kind: 'unknown' }, { kind: 'unknown' }, { kind: 'unknown' }]);
      const details = finished()
        .slice(start)
        .filter(span => span.name === 'chat.detail.provider');
      assert.equal(details.length, 4);
      assert.ok(details.every(span => span.attributes.outcome === 'error'));
      const timeout = new DOMException('PRIVATE BODY TIMEOUT', 'TimeoutError');
      t.mock.method(globalThis, 'fetch', async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => {
          throw timeout;
        },
      }));
      const timed = finished().length;
      await assert.rejects(
        withChatMeasurements(() =>
          inferWithSystem(nativeRoutes.azure, 'PRIVATE SYSTEM', messages, async () => async usage => {
            settled.push(usage);
          }),
        ),
        { message: 'model-invalid-response' },
      );
      assert.deepEqual(settled.at(-1), { kind: 'unknown' });
      assert.equal(
        finished()
          .slice(timed)
          .find(span => span.name === 'chat.detail.provider').attributes.outcome,
        'error',
      );
    });
    await t.test(
      'discovery and every helper request have sizes and distinct purposes without exporting evidence',
      async t => {
        const call = {
          tool: 'google.propose',
          operation: { kind: 'calendar.calendars.create', calendar: { summary: 'QA.' } },
        };
        const source = {
          summary: { mode: 'literal', source: { message: 0, text: 'QA.' } },
          description: { mode: 'unspecified' },
        };
        const replies = [
          nativeReply('azure', {
            calls: [
              {
                id: 'PRIVATE CALL',
                name: 'tools_search',
                input: { query: 'google propose PRIVATE QUERY' },
                providerId: true,
              },
            ],
          }),
          nativeReply('azure', { calls: [useCall(call)] }),
          selectReply('azure', source),
          nativeReply('azure', { text: answer.text }),
          completionReply('azure'),
          nativeReply('anthropic', { text: 'Calendar title' }),
          nativeReply('azure', { text: 'PRIVATE SUMMARY' }),
        ];
        const sent = [];
        t.mock.method(globalThis, 'fetch', async (_url, init) => {
          sent.push(init.body);
          return Response.json(replies.shift());
        });
        const count = finished().length;
        const logs = detailLogs.length;
        await withChatMeasurements(async () => {
          assert.deepEqual(
            await inferWithTools(
              nativeRoutes.azure,
              [{ role: 'user', text: 'Create calendar "QA."' }],
              async () => ({ id: 'PRIVATE REVIEW' }),
              undefined,
              true,
              null,
              {
                titleRoute: nativeRoutes.anthropic,
                readPersonalMemory: async () => undefined,
                readWorkspaceInventory: async () => undefined,
                catalog: async () => undefined,
              },
            ),
            { text: answer.text, title: 'Calendar title' },
          );
          assert.equal(await inferWithSystem(nativeRoutes.azure, 'PRIVATE SYSTEM', messages), 'PRIVATE SUMMARY');
        });
        const requests = finished()
          .slice(count)
          .filter(span => span.name === 'chat.detail.request');
        assert.deepEqual(
          requests.map(span => span.attributes['chat.purpose']),
          ['reply', 'reply', 'calendar', 'reply', 'completion', 'title', 'compaction'],
        );
        assert.deepEqual(
          requests.map(span => span.attributes['chat.request.sequence']),
          [1, 2, 3, 4, 5, 6, 7],
        );
        const records = detailLogs.slice(logs);
        const discovery = records.find(record => record.operation === 'chat.discovery');
        assert.ok(discovery['chat.discovery.added'] > 0);
        assert.equal(discovery['chat.discovery.loaded'], discovery['chat.discovery.added']);
        assert.equal(discovery['chat.discovery.matched'], discovery['chat.discovery.added']);
        const wire = records.filter(record => record['chat.request.wire_bytes'] !== undefined);
        assert.deepEqual(
          wire.map(record => record['chat.request.wire_bytes']),
          sent.map(value => Buffer.byteLength(value)),
        );
        assert.ok(wire[1]['chat.request.tools_bytes'] > wire[0]['chat.request.tools_bytes']);
        assert.ok(wire[1]['chat.request.messages_bytes'] > wire[0]['chat.request.messages_bytes']);
        assert.ok(
          records.some(
            record =>
              record['chat.request.completion-evidence_bytes'] > 0 &&
              record['chat.request.candidate_bytes'] === Buffer.byteLength(answer.text),
          ),
        );
        for (const phase of [
          'round-prepare',
          'catalog',
          'memory',
          'inventory',
          'tool-schemas',
          'render',
          'serialize',
          'discovery',
          'completion-context',
        ]) {
          assert.ok(
            finished()
              .slice(count)
              .some(span => span.name === `chat.detail.${phase}`),
            phase,
          );
        }
      },
    );
    await reader.forceFlush();
    metrics = metricExporter.getMetrics().flatMap(resource => resource.scopeMetrics.flatMap(scope => scope.metrics));
    assert.doesNotMatch(JSON.stringify(detailLogs), /PRIVATE|synthetic-key|https:|tools_search|google_propose/);
    assert.doesNotMatch(
      JSON.stringify({
        spans: finished().map(({ name, attributes, events, status }) => ({ name, attributes, events, status })),
        metrics,
      }),
      /PRIVATE|synthetic-key|https:|select_action/,
    );
  } finally {
    await sdk.shutdown();
  }
});

for (const [format, metadata, token] of [
  [
    'anthropic',
    [
      { type: 'message_start', message: { usage: { output_tokens: 1 } } },
      { type: 'ping' },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'tool', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '' } },
    ],
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
  ],
  [
    'chat-completions',
    [
      { model: 'model', choices: [{ index: 0, delta: { role: 'assistant' } }] },
      { choices: [], usage: { completion_tokens: 1 } },
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, id: 'id', function: { name: 'tool', arguments: '' } }] } },
        ],
      },
    ],
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }] },
  ],
  [
    'responses',
    [
      { type: 'response.created', response: {} },
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'id' } },
      { type: 'response.function_call_arguments.delta', delta: '' },
    ],
    { type: 'response.function_call_arguments.delta', delta: '{}' },
  ],
])
  test(`${format} TTFT ignores metadata and empty deltas and detects tool arguments without visible text`, async () => {
    let count = 0;
    const options = {
      onText: undefined,
      onFirstToken: () => {
        count++;
      },
    };
    await readModelResponse(streamResponse(metadata), format, options);
    assert.equal(count, 0);
    await readModelResponse(streamResponse([...metadata, token, token]), format, options);
    assert.equal(count, 1);
    await readModelResponse(Response.json({ text: 'not streaming' }), format, options);
    assert.equal(count, 1);
  });

for (const [format, events] of [
  [
    'anthropic',
    [
      { type: 'message_start', message: {} },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
    ],
  ],
  ['chat-completions', [{ choices: [{ index: 0, delta: { content: 'Hi' } }] }]],
  ['responses', [{ type: 'response.output_text.delta', delta: 'Hi' }]],
])
  test(`${format} text output reports first token even with a throwing answer consumer`, async () => {
    let count = 0;
    await assert.rejects(
      readModelResponse(streamResponse(events), format, {
        onFirstToken: () => {
          count++;
        },
        onText: () => {
          throw new Error('consumer');
        },
      }),
      { message: 'consumer' },
    );
    assert.equal(count, 1);
  });
