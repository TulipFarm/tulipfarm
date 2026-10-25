import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { privateSpanExporter } from '@tulipfarm/observability';

// One SDK per process: the OpenTelemetry globals can be registered only once.
const raw = new InMemorySpanExporter();
const exported = new InMemorySpanExporter();
let started;

/**
 * Records every span as created (`raw`) and as exported (`exported`, after the private exporter's allowlist), and
 * every JSON log line written to stdout, for the rest of test `t`.
 */
export function captureTelemetry(t) {
  if (!started) {
    started = new NodeSDK({
      resource: resourceFromAttributes({ 'service.name': 'images-telemetry' }),
      autoDetectResources: false,
      instrumentations: [],
      spanProcessors: [new SimpleSpanProcessor(raw), new SimpleSpanProcessor(privateSpanExporter(exported))],
    });
    started.start();
  }
  raw.reset();
  exported.reset();
  const logs = [];
  const write = process.stdout.write;
  t.mock.method(process.stdout, 'write', function (chunk, ...rest) {
    const text = String(chunk);
    if (text.startsWith('{')) logs.push(text);
    return write.call(process.stdout, chunk, ...rest);
  });
  return {
    raw: () => raw.getFinishedSpans(),
    exported: () => exported.getFinishedSpans(),
    logs: () => logs.map(line => JSON.parse(line)),
    /** Everything telemetry would send: exported span names and attributes, and log lines. */
    sent: () =>
      JSON.stringify({
        spans: exported.getFinishedSpans().map(span => ({ name: span.name, attributes: span.attributes })),
        logs,
      }),
  };
}
