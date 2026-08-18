import type { NoiseFloor } from "./noise.ts";
import type { Scorecard } from "./runner.ts";
import { caseIdsOf, caseVerdict, scoreable, VERDICT, type Verdict } from "./verdict.ts";

/**
 * What happened to one Case between the Baseline and this Sweep.
 *
 * There is no "added" or "removed": an identical `corpusHash` means an identical Corpus, so a Case
 * on one side and not the other was never *run* — filtered out, or past the ceiling — rather than
 * authored or deleted. A Corpus that genuinely changed is refused outright.
 *
 * `not-comparable` is deliberately not a third kind of bad news. A vendor error, an unmeasured Case
 * or a vacuous one says nothing about the harness, and counting any of them as a regression would
 * make the delta report exactly the noise this framework exists to remove.
 */
export type CaseChange = "fixed" | "regressed" | "unchanged" | "not-comparable" | "no-signal";

export interface CaseDelta {
  readonly caseId: string;
  readonly change: CaseChange;
  /** What the Baseline saw. `-` when the Baseline never reached this Case. */
  readonly before: Verdict;
  /** What this Sweep saw. `-` when this Sweep never reached it. */
  readonly after: Verdict;
}

export interface Delta {
  readonly corpusHash: string;
  readonly modelId: string;
  readonly cases: readonly CaseDelta[];
  readonly regressed: number;
  readonly fixed: number;
  /** Cases that moved, on which the Baseline's own repeated Trials had already disagreed. */
  readonly noSignal: number;
  /** The floor this delta was damped against, when the Baseline recorded one. */
  readonly floor?: NoiseFloor;
  /**
   * How many *Cases* passed on each side — never Trials.
   *
   * A Baseline is promoted with `--repeat n` and a release check runs once, so a Trial count puts
   * the two sides on different scales: an unchanged Sweep reads as "55 passed before, 11 after",
   * which is a collapse to every eye that sees it and a lie under every one that reads on.
   */
  readonly passedBefore: number;
  readonly passedAfter: number;
}

/**
 * Thrown rather than returned: a delta between incomparable Scorecards is a confident, precise,
 * entirely fictitious number, and it is the most dangerous artifact this framework could produce.
 */
export class BaselineMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaselineMismatchError";
  }
}

/**
 * A movement is only news on a Case that held still when nothing changed.
 *
 * The Baseline's own repeated Trials are the evidence. A Case that disagreed with itself there
 * will disagree again, and reporting that as a regression would train a maintainer to ignore the
 * report — which is strictly worse than not producing one. Damping is per Case rather than by
 * count: a regression on a Case that never flapped is real however many others did.
 */
function changeOf(before: Verdict, after: Verdict, flapping: readonly string[], id: string) {
  if (!scoreable(before) || !scoreable(after)) return "not-comparable" as const;
  if (before === after) return "unchanged" as const;
  if (flapping.includes(id)) return "no-signal" as const;
  return after === VERDICT.passed ? ("fixed" as const) : ("regressed" as const);
}

/**
 * Measure this Sweep against a stored reference.
 *
 * A Scorecard on its own is an absolute number nobody can interpret — 14 of 20 is neither good nor
 * bad. Against a Baseline it becomes a change, which is the only thing a release decision needs.
 *
 * @throws BaselineMismatchError when the two measured different things. A Corpus edit would
 * otherwise manufacture an improvement out of nothing but a reworded Expectation.
 */
export function compareToBaseline(baseline: Scorecard, current: Scorecard): Delta {
  if (baseline.corpusHash !== current.corpusHash) {
    throw new BaselineMismatchError(
      `Baseline measured Corpus ${baseline.corpusHash} and this Sweep measured ${current.corpusHash}. ` +
        "A delta across two Corpora is not a delta: re-run the Baseline, or promote a new one."
    );
  }
  if (baseline.modelId !== current.modelId) {
    throw new BaselineMismatchError(
      `Baseline measured ${baseline.modelId} and this Sweep measured ${current.modelId}. ` +
        "Models are not comparable with each other; keep one Baseline per model."
    );
  }

  const ids = [...caseIdsOf(baseline)];
  for (const id of caseIdsOf(current)) if (!ids.includes(id)) ids.push(id);

  const flapping = baseline.noise?.flapping ?? [];
  const cases = ids.map((caseId): CaseDelta => {
    const before = caseVerdict(baseline, caseId);
    const after = caseVerdict(current, caseId);
    return { caseId, change: changeOf(before, after, flapping, caseId), before, after };
  });

  return {
    corpusHash: current.corpusHash,
    modelId: current.modelId,
    cases,
    regressed: cases.filter((c) => c.change === "regressed").length,
    fixed: cases.filter((c) => c.change === "fixed").length,
    noSignal: cases.filter((c) => c.change === "no-signal").length,
    ...(baseline.noise === undefined ? {} : { floor: baseline.noise }),
    passedBefore: cases.filter((c) => c.before === VERDICT.passed).length,
    passedAfter: cases.filter((c) => c.after === VERDICT.passed).length,
  };
}
