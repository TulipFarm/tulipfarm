import { metrics } from '@opentelemetry/api';
import { metrics as sdk } from '@opentelemetry/sdk-node';

/** Records every metric for the rest of test `t`. `points(name)` reads one counter's attributes and totals so far. */
export function captureMetrics(t) {
  const exporter = new sdk.InMemoryMetricExporter(sdk.AggregationTemporality.CUMULATIVE);
  const reader = new sdk.PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60000 });
  metrics.disable();
  metrics.setGlobalMeterProvider(new sdk.MeterProvider({ readers: [reader] }));
  t.after(() => metrics.disable());
  return {
    async points(name) {
      await reader.forceFlush();
      return (exporter.getMetrics().at(-1)?.scopeMetrics ?? [])
        .flatMap(scope => scope.metrics)
        .filter(metric => metric.descriptor.name === name)
        .flatMap(metric => metric.dataPoints)
        .map(point => ({ ...point.attributes, value: point.value }));
    },
  };
}
