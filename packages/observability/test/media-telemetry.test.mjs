import assert from 'node:assert/strict';
import test from 'node:test';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { observeInference, observeMedia, privateSpanExporter } from '../src/index.ts';

test('media spans and failure logs keep counts, sizes, media types and outcomes, and drop anything else', async t => {
  const spans = new InMemorySpanExporter();
  const records = new InMemoryLogRecordExporter();
  const sdk = new NodeSDK({
    autoDetectResources: false,
    instrumentations: [],
    spanProcessors: [new SimpleSpanProcessor(privateSpanExporter(spans))],
    logRecordProcessors: [new SimpleLogRecordProcessor({ exporter: records })],
  });
  sdk.start();
  t.after(() => sdk.shutdown());
  const lines = [];
  t.mock.method(process.stdout, 'write', chunk => void lines.push(String(chunk)));

  // Values a careless caller might pass: a filename riding on the media type, text in place of an outcome, a URL.
  const leaky = {
    'media.kind': 'video',
    'media.type': 'image/png; name="PRIVATE.png"',
    'media.bytes': -1,
    'media.outcome': 'PRIVATE TEXT',
    'media.quality': 'https://example.com/?token=PRIVATE',
    'media.sources': 1.5,
  };
  await assert.rejects(
    observeMedia(
      'media.recognize',
      { 'media.kind': 'image', 'media.type': 'image/png', 'media.bytes': 119 },
      record => {
        record({ ...leaky, 'media.outcome': 'failed' });
        throw new Error('upstream refused');
      },
    ),
  );
  await observeInference({ provider: 'openai', model: 'gpt-image-1', operation: 'image_generation' }, async report => {
    report.media({ 'media.sources': 2, 'media.source_bytes': 4096, 'media.quality': 'high' });
    report.media(leaky);
    report.media({ 'media.outcome': 'image', 'media.type': 'image/png', 'media.bytes': 2048 });
  });

  const media = span => Object.fromEntries(Object.entries(span.attributes).filter(([key]) => key.startsWith('media.')));
  const [recognize, generate] = spans.getFinishedSpans();
  assert.equal(recognize.name, 'media.recognize');
  // A rejected value replaces the earlier one on the span, so the key is dropped rather than kept stale.
  assert.deepEqual(media(recognize), { 'media.outcome': 'failed' });
  assert.equal(generate.name, 'image_generation gpt-image-1');
  assert.deepEqual(media(generate), {
    'media.source_bytes': 4096,
    'media.outcome': 'image',
    'media.type': 'image/png',
    'media.bytes': 2048,
  });
  const failed = lines.map(line => JSON.parse(line)).find(line => line.event === 'call_failed');
  assert.equal(failed.operation, 'media.recognize');
  assert.equal(failed['media.outcome'], 'failed');
  assert.doesNotMatch(lines.join(''), /PRIVATE/);
  assert.doesNotMatch(JSON.stringify(records.getFinishedLogRecords().map(record => record.attributes)), /PRIVATE/);
});
