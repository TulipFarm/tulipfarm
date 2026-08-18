import type { Scorecard } from "./runner.ts";

/**
 * What a Case did, once its Trials are collapsed into one word.
 *
 * Shared rather than local to the renderer, because a Baseline comparison has to collapse a Case
 * exactly as the Matrix grid does. Two functions that disagreed would report a regression the grid
 * does not show, and no reader could tell which was lying.
 */
export const VERDICT = {
  passed: "PASS",
  failed: "FAIL",
  /** A vendor fault. Never a verdict on the harness — that is the confound this framework removes. */
  errored: "ERR",
  /** The Case expected nothing, so a green Trial proves nothing. */
  vacuous: "VAC",
  /**
   * A `guard_held` Case the model defused before its guard was asked to refuse.
   *
   * Not a pass — the guard proved nothing. Not a failure — nothing leaked. Not scoreable, so the
   * Matrix and the Baseline hold it out exactly as they hold out a vendor fault.
   */
  unexercised: "UNEX",
  /** The Sweep never reached this Case, because it stopped early. */
  notRun: "-",
  /** This model produced no Scorecard at all. */
  unavailable: "n/a",
} as const;

export type Verdict = (typeof VERDICT)[keyof typeof VERDICT];

/** A verdict the Corpus actually produced, and so one that can be compared with another. */
export function scoreable(v: string): boolean {
  return v === VERDICT.passed || v === VERDICT.failed || v === VERDICT.vacuous;
}

/** One Case's verdict for one model, collapsed from however many Trials it ran. */
export function caseVerdict(card: Scorecard, caseId: string): Verdict {
  const trials = card.trials.filter((t) => t.caseId === caseId);
  if (trials.length === 0) return VERDICT.notRun;
  if (trials.some((t) => t.error !== undefined)) return VERDICT.errored;
  if (trials.some((t) => t.vacuous)) return VERDICT.vacuous;
  // `every`, not `some`: one Trial that reached the guard is worth more than one that did not, so a
  // Case only collapses to UNEX when no Trial of it ever exercised the guard.
  if (trials.every((t) => t.unexercised === true)) return VERDICT.unexercised;
  return trials.every((t) => t.passed) ? VERDICT.passed : VERDICT.failed;
}

/** Case ids in the order the Scorecard first saw them. */
export function caseIdsOf(card: Scorecard): string[] {
  const seen: string[] = [];
  for (const trial of card.trials) if (!seen.includes(trial.caseId)) seen.push(trial.caseId);
  return seen;
}
