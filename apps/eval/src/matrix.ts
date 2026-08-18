import { type ModelBinding, runSweep, type Scorecard, type SweepOptions } from "./runner.ts";

/** One model's leg of a Matrix: a Scorecard, or the reason there is none. */
export interface ModelRun {
  readonly modelId: string;
  readonly card?: Scorecard;
  /** Why this model produced no Scorecard — a missing credential, or a vendor that never answered. */
  readonly unavailable?: string;
}

/**
 * The same Corpus measured against several models.
 *
 * The models are a **control on the harness**, not competitors. A Case that passes on one and
 * fails on the other says the harness change under test lands differently on each — which is the
 * thing a maintainer needs to see before a release. It does not say one model is better.
 */
export interface Matrix {
  readonly corpusHash: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly runs: readonly ModelRun[];
}

/**
 * Every Sweep knob, plus the models to apply them to.
 *
 * Extends `SweepOptions` rather than restating it: the fields were listed twice and forwarded by
 * hand, so `repeat` was added to the Sweep, accepted by the CLI, and silently dropped here — a
 * Sweep that ran once while reporting it had repeated. Deriving the type makes the next such
 * addition a compile error, and forwarding by rest spread makes it require no forwarding at all.
 */
export interface MatrixOptions extends Omit<SweepOptions, "model"> {
  /** Measured in the order given; never reordered by result. */
  readonly models: readonly ModelBinding[];
  /** Seam for tests; production always runs the real Sweep. */
  sweep?(options: SweepOptions): Promise<Scorecard>;
}

/**
 * Run the Corpus against every model, one at a time.
 *
 * Sequential on purpose. Both models are subscription seats with their own rate limits, and two
 * Sweeps in flight make throttling likelier — which shows up as retries and changed timing in
 * whichever Scorecard was unlucky. Each model is measured as if it were the only one.
 */
/**
 * Decide whether a Scorecard is a measurement at all.
 *
 * `runSweep` almost never rejects: a missing credential surfaces inside the call, so it lands as an
 * errored Trial like any vendor fault, and a dead seat yields a full Scorecard of them. Rendering
 * that beside a healthy model would put an ERR in every cell of one column, which reads like the
 * harness behaving differently under that model when nothing was measured at all. A Sweep that
 * never scored a single Case is the model being unavailable, and is reported as that.
 */
function wholeModelFault(card: Scorecard): { unavailable: string } | undefined {
  if (card.errored === 0 || card.passed + card.failed > 0) return undefined;
  const reason = card.trials.find((t) => t.error !== undefined)?.error;
  return { unavailable: `every Trial errored — ${reason ?? "no reason reported"}` };
}

export async function runMatrix(options: MatrixOptions): Promise<Matrix> {
  const now = options.now ?? (() => new Date());
  const { models: _models, sweep: _sweep, ...tuning } = options;
  const sweep = options.sweep ?? runSweep;
  const started = now();
  const runs: ModelRun[] = [];

  for (const model of options.models) {
    try {
      const card = await sweep({ ...tuning, model });

      const dead = wholeModelFault(card);
      runs.push(dead === undefined ? { modelId: model.id, card } : { modelId: model.id, ...dead });
    } catch (error) {
      // One model's credential or outage must not discard the other's whole Sweep. The Matrix
      // records the gap instead, so the result reads as incomplete rather than as complete.
      runs.push({
        modelId: model.id,
        unavailable: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    corpusHash: options.corpus.hash,
    startedAt: started.toISOString(),
    durationMs: now().getTime() - started.getTime(),
    runs,
  };
}
