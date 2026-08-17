import type { Scorecard } from "./runner.ts";
import { caseIdsOf } from "./verdict.ts";

/**
 * How much a Sweep's own verdicts moved without the harness changing.
 *
 * There is no temperature, top-p or seed control anywhere in the model invocation path, so a Sweep
 * cannot be run at temperature 0 and two identical Sweeps are not guaranteed to agree. That is
 * tolerable only if the disagreement is measured: without this number every delta is read as a
 * change the harness caused, and the framework's whole claim — that it separates a real improvement
 * from run-to-run variance — is unfounded.
 */
export interface NoiseFloor {
  /** The fewest Trials any measured Case ran. A floor means nothing below 2. */
  readonly repeats: number;
  /** Cases whose own repeated Trials disagreed with each other. */
  readonly flapping: readonly string[];
  /** Cases that ran two or more scoreable Trials, and so could be measured at all. */
  readonly measured: number;
}

/**
 * Measure the floor from a Sweep that repeated its Corpus, or `undefined` when it did not.
 *
 * Only Trials that scored the harness count. An `ERR` Trial is a vendor fault and a vacuous one
 * asserted nothing, so a Case carrying either is held out rather than counted as agreement — the
 * same rule the Matrix and the Baseline delta already apply.
 */
export function measureNoise(card: Scorecard): NoiseFloor | undefined {
  const ids = caseIdsOf(card);
  const flapping: string[] = [];
  let measured = 0;
  let repeats = Number.POSITIVE_INFINITY;

  for (const caseId of ids) {
    const ran = card.trials.filter((t) => t.caseId === caseId);
    // Taken across every Case, including the ones nothing could be measured on: a Sweep that
    // stopped after one Trial of the last Case has not repeated the Corpus, and reporting the
    // repeat count of its luckiest Case would overstate how much of the Corpus the floor covers.
    repeats = Math.min(repeats, ran.length);

    // Probabilistic red-team Trials are held out too. They are *expected* to disagree — that
    // disagreement is the resistance rate — so counting them would report the measurement itself
    // as noise and damp every real capability regression alongside it.
    const scoreable = ran.filter(
      (t) => t.error === undefined && !t.vacuous && t.probabilistic !== true
    );
    if (scoreable.length < 2) continue;
    measured += 1;
    if (scoreable.some((t) => t.passed !== scoreable[0]?.passed)) flapping.push(caseId);
  }

  // Every Case ran once, so nothing was repeated and there is no floor. Reporting zero here would
  // be the dangerous answer: zero reads as "measured, and found stable".
  if (card.trials.length <= ids.length) return undefined;

  return { repeats: Number.isFinite(repeats) ? repeats : 1, flapping, measured };
}

/**
 * How many Cases may move between two Sweeps before the movement means anything.
 *
 * Zero without a measured floor, so an unmeasured Baseline excuses nothing. The alternative —
 * assuming some tolerance — would silently swallow real regressions on the Baselines that happen
 * to carry the least evidence.
 */
export function noiseBand(floor: NoiseFloor | undefined): number {
  return floor?.flapping.length ?? 0;
}
