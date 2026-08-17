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
export type CaseChange = "fixed" | "regressed" | "unchanged" | "not-comparable";

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

function changeOf(before: Verdict, after: Verdict): CaseChange {
  if (!scoreable(before) || !scoreable(after)) return "not-comparable";
  if (before === after) return "unchanged";
  return after === VERDICT.passed ? "fixed" : "regressed";
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

  const cases = ids.map((caseId): CaseDelta => {
    const before = caseVerdict(baseline, caseId);
    const after = caseVerdict(current, caseId);
    return { caseId, change: changeOf(before, after), before, after };
  });

  return {
    corpusHash: current.corpusHash,
    modelId: current.modelId,
    cases,
    regressed: cases.filter((c) => c.change === "regressed").length,
    fixed: cases.filter((c) => c.change === "fixed").length,
    passedBefore: baseline.passed,
    passedAfter: current.passed,
  };
}
