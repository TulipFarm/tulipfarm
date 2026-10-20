import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  authoringFixture,
  improveInput,
  providerResponse,
  workspaceId,
  userId,
} from './authoring-assistance-fixture.mjs';

test('authoring telemetry records model and usage but never draft, answer, or provider error text', async () => {
  const spans = new InMemorySpanExporter();
  const sdk = new NodeSDK({ autoDetectResources: false, spanProcessors: [new SimpleSpanProcessor(spans)] });
  sdk.start();
  try {
    const fixture = authoringFixture();
    fixture.state.response = model => Response.json(providerResponse(model, 'PRIVATE GENERATED INSTRUCTIONS'));
    await fixture.service.improve(workspaceId, userId, {
      ...improveInput(),
      agentName: 'PRIVATE AGENT NAME',
      instructions: 'PRIVATE DRAFT INSTRUCTIONS',
    });
    const success = spans.getFinishedSpans().find(span => span.attributes['gen_ai.request.model'] === 'gpt-6-luna');
    assert.ok(success);
    assert.equal(success.attributes['gen_ai.usage.input_tokens'], 40);
    assert.equal(success.attributes['gen_ai.usage.output_tokens'], 10);
    fixture.state.response = () => Response.json({ error: { message: 'PRIVATE PROVIDER ERROR' } }, { status: 503 });
    await assert.rejects(fixture.service.improve(workspaceId, userId, improveInput()), /provider-unavailable/);
    const captured = spans
      .getFinishedSpans()
      .map(span => ({ attributes: span.attributes, events: span.events, status: span.status }));
    assert.doesNotMatch(JSON.stringify(captured), /PRIVATE DRAFT|PRIVATE GENERATED|PRIVATE PROVIDER|PRIVATE AGENT/);
  } finally {
    await sdk.shutdown();
  }
});
