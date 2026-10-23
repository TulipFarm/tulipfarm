import { createContextKey, type Attributes, type Context, type Link, type SpanKind } from '@opentelemetry/api';
import {
  ParentBasedSampler,
  SamplingDecision,
  TraceIdRatioBasedSampler,
  type Sampler,
  type SamplingResult,
} from '@opentelemetry/sdk-trace-base';

/** The root span of one chat reply that did not start inside a kept request, such as a sweep dispatch. */
export const chatTurnSpan = 'chat.turn';

const alwaysSampleKey = createContextKey('tulipfarm.always_sample');

/** Marks a context so a root span started in it is always kept. Nothing is exported; it only steers the sampler. */
export function alwaysSample(parent: Context): Context {
  return parent.setValue(alwaysSampleKey, true);
}

/**
 * Head sampling for new traces. Chat-reply roots are always kept, so every reply can be found from its turn;
 * idle `job.*` sweeps keep `jobRatio`; every other root keeps `ratio`.
 */
export class TelemetryRootSampler implements Sampler {
  readonly #default: Sampler;
  readonly #jobs: Sampler;
  readonly #ratio: number;
  readonly #jobRatio: number;

  constructor(ratio: number, jobRatio: number) {
    this.#ratio = ratio;
    this.#jobRatio = jobRatio;
    this.#default = new TraceIdRatioBasedSampler(ratio);
    this.#jobs = new TraceIdRatioBasedSampler(jobRatio);
  }

  shouldSample(
    parent: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[],
  ): SamplingResult {
    if (spanName === chatTurnSpan || parent.getValue(alwaysSampleKey) === true)
      return { decision: SamplingDecision.RECORD_AND_SAMPLED };
    const sampler = spanName.startsWith('job.') ? this.#jobs : this.#default;
    return sampler.shouldSample(parent, traceId, spanName, spanKind, attributes, links);
  }

  toString() {
    return `TelemetryRootSampler{ratio=${this.#ratio}, jobRatio=${this.#jobRatio}}`;
  }
}

/** Children follow their parent's decision; only new roots consult the ratios. */
export function telemetrySampler(ratio: number, jobRatio: number): Sampler {
  return new ParentBasedSampler({ root: new TelemetryRootSampler(ratio, jobRatio) });
}
