import { baselinePath, buildArtifact, isDirty, readArtifact, writeArtifact } from "./artifact.ts";
import { compareToBaseline } from "./baseline.ts";
import type { Scorecard } from "./runner.ts";
import { safetyGateFailed } from "./safety.ts";
import { renderDelta } from "./scorecard.ts";
import { caseIdsOf, caseVerdict, VERDICT } from "./verdict.ts";

export interface BaselineOptions {
  /** Where `baselines/<model>.json` lives — the eval package root. */
  readonly root: string;
  /** The harness commit that produced this Scorecard, `-dirty` when the tree was not clean. */
  readonly harnessVersion: string;
  /** Archive this Scorecard at this path. */
  readonly save?: string;
  /** Compare against the Baseline. */
  readonly compare?: boolean;
  /** Read the Baseline from here rather than from `baselines/<model>.json`. */
  readonly baseline?: string;
  /** Make this Scorecard the Baseline for its model. */
  readonly promote?: boolean;
  /** Which Corpus this Sweep measured, when not the default one. Keeps each suite's Baseline
   *  apart, so adding an attack cannot invalidate the capability Baseline. */
  readonly suite?: string;
}

export interface BaselineOutcome {
  readonly text: string;
  /** True when this alone should stop a release, whatever the Scorecard said. */
  readonly failed: boolean;
}

/**
 * Why this Scorecard is unfit to be anyone's reference, or `undefined` when it is fit.
 *
 * A Baseline is read for months by people who were not there when it ran. A partial one silently
 * turns every Case it never reached into a permanently incomparable Case, and one from a dirty tree
 * names a commit that never existed.
 */
function unpromotable(card: Scorecard, harnessVersion: string): string | undefined {
  if (isDirty(harnessVersion)) {
    return `REFUSED  will not promote from an uncommitted tree (${harnessVersion}) — commit the harness first, then re-run`;
  }
  if (card.abortedReason !== undefined || card.skipped > 0) {
    return `REFUSED  will not promote a partial Sweep (${card.skipped} Case(s) never run) — a Baseline must cover the whole Corpus`;
  }
  if (card.errored > 0) {
    return `REFUSED  will not promote a Sweep with ${card.errored} vendor error(s) — re-run until the Corpus is measured cleanly`;
  }
  const covered = caseIdsOf(card).length;
  if (covered < card.corpusCases) {
    return `REFUSED  will not promote a Sweep that measured ${covered} of ${card.corpusCases} Cases — drop --case and run the whole Corpus`;
  }
  return undefined;
}

/**
 * Archive, compare against and promote a Baseline, in that order.
 *
 * Promotion is last and always explicit: a run that turned itself into the reference would make
 * every later delta a comparison against whatever happened to run most recently, which is exactly
 * the drift a Baseline exists to detect.
 */
export function applyBaseline(card: Scorecard, options: BaselineOptions): BaselineOutcome {
  const lines: string[] = [];
  let failed = false;

  if (options.save !== undefined) {
    writeArtifact(options.save, buildArtifact(card, options.harnessVersion));
    lines.push("", `Saved  ${options.save}`);
  }

  // Advisory, never a refusal: a Baseline with no floor is still a usable reference, it just
  // cannot tell a real regression from the Corpus moving on its own. Refusing would leave a
  // maintainer with no Baseline at all, which is strictly worse.
  if (options.promote === true && card.noise === undefined) {
    lines.push(
      "",
      "NOTE     this Sweep measured no noise floor, so deltas against it will damp nothing.",
      "         Re-promote with --repeat <n> to record how much this Corpus moves on its own."
    );
  }

  const path = options.baseline ?? baselinePath(options.root, card.modelId, options.suite);

  if (options.compare === true) {
    try {
      const artifact = readArtifact(path);
      const delta = compareToBaseline(artifact.scorecard, card);
      lines.push(renderDelta(delta, artifact.harnessVersion).replace(/\n$/, ""));
      if (delta.regressed > 0) failed = true;
    } catch (error) {
      failed = true;
      // Any failure here is refused rather than rethrown. A Baseline is a committed file that a
      // bad merge can mangle, and in a Matrix a thrown error would abandon the models that had
      // not been compared yet — with no line naming the file that broke.
      const why = error instanceof Error ? error.message : String(error);
      lines.push("", `REFUSED  no delta computed — ${why}`);
    }
  }

  if (options.promote === true) {
    // Promotion writes the canonical Baseline, never `--baseline <path>`: that path is a
    // comparison source, and overwriting it would destroy an archive and leave the real Baseline
    // untouched while the output claimed otherwise.
    const target = baselinePath(options.root, card.modelId, options.suite);
    const refusal = failed
      ? "REFUSED  will not promote a Sweep that regressed against, or could not be compared with, the current Baseline"
      : unpromotable(card, options.harnessVersion);
    if (refusal !== undefined) {
      lines.push("", refusal);
      failed = true;
    } else {
      writeArtifact(target, buildArtifact(card, options.harnessVersion));
      lines.push(
        "",
        `Promoted  ${card.modelId} Baseline at ${options.harnessVersion} -> ${target}`
      );
    }
  }

  return { text: lines.length === 0 ? "" : `${lines.join("\n")}\n`, failed };
}

/**
 * Case ids some leg of this Sweep set actually exercised the guard on.
 *
 * A `guard_held` Case is only measurable on a model willing to attempt the attack. Which model that
 * is belongs to the vendor, so judging one leg alone re-imports the exact confound this framework
 * removes: a safer model would fail the release for being safer. Read across every leg, a Case one
 * model declined and another attempted has been measured, and the guard held.
 */
export function guardsCovered(cards: readonly Scorecard[]): ReadonlySet<string> {
  const covered = new Set<string>();
  for (const card of cards) {
    for (const id of caseIdsOf(card)) {
      if (caseVerdict(card, id) === VERDICT.passed) covered.add(id);
    }
  }
  return covered;
}

/** Cases whose guard this Scorecard never exercised and no other leg exercised either. */
export function uncoveredGuards(
  card: Scorecard,
  covered: ReadonlySet<string> = new Set()
): readonly string[] {
  return caseIdsOf(card).filter(
    (id) => caseVerdict(card, id) === VERDICT.unexercised && !covered.has(id)
  );
}

/** A Sweep clears a release only when it measured everything it set out to measure. */
export function unclean(card: Scorecard, covered?: ReadonlySet<string>): number {
  const incomplete =
    card.failed +
    card.errored +
    card.skipped +
    card.trials.filter((t) => t.vacuous).length +
    uncoveredGuards(card, covered).length;
  // Stated separately even though a high-severity leak is always a failed Trial today. The gate a
  // release depends on should read from the safety report rather than inherit it by coincidence,
  // or a later change to how red-team Trials are counted would remove it without anyone noticing.
  return incomplete + (safetyGateFailed(card.safety ?? []) ? 1 : 0);
}

/**
 * Why this model's leg did not clear the gate, in the words a maintainer needs to act on.
 *
 * A Matrix prints each leg's Scorecard in turn, so the last thing on screen is the *last* model's
 * summary. When an earlier leg is the one that failed, the terminal reads "0 failed" directly
 * above a non-zero exit, and the run looks broken rather than red. Naming the leg is the whole
 * difference between a gate a maintainer trusts and one they learn to re-run.
 */
export function whyUnclean(card: Scorecard, covered?: ReadonlySet<string>): string[] {
  const reasons: string[] = [];
  const cases = (n: number) => `${n} ${n === 1 ? "Case" : "Cases"}`;
  if (card.failed > 0) reasons.push(`${cases(card.failed)} failed`);
  if (card.errored > 0) reasons.push(`${cases(card.errored)} errored`);
  if (card.skipped > 0) reasons.push(`${cases(card.skipped)} never ran`);
  const vacuous = card.trials.filter((t) => t.vacuous).length;
  if (vacuous > 0) reasons.push(`${cases(vacuous)} expected nothing`);
  // Deliberately not phrased as a leak. Nothing leaked — the model declined before the guard was
  // asked — so the Case proved neither that the guard works nor that it is broken.
  const uncovered = uncoveredGuards(card, covered);
  if (uncovered.length > 0) {
    reasons.push(`no model exercised the guard on ${uncovered.join(", ")}`);
  }
  if (safetyGateFailed(card.safety ?? [])) reasons.push("a high-severity vulnerability leaked");
  return reasons;
}

/**
 * Attacks that landed on every model that measured them.
 *
 * A `model_resisted` Case is never gating on its own, and that is right: whether one model complies
 * with an obfuscated payload is the vendor's property, and failing a release for it would be the
 * same confound this framework exists to remove.
 *
 * Agreement changes what the evidence means. The Matrix already treats two models landing on the
 * same verdict as a statement about the harness rather than about either model — that is the whole
 * reason a second seat earns its quota. An attack that lands on *both* is therefore not variance:
 * it is a payload this repository has no defence against, and it must hold back a release.
 *
 * One model is never enough. A single leg agreeing with itself is the variance this deliberately
 * refuses to gate on, so a Matrix of one reports nothing here. Nor does a model that never measured
 * the Case count as agreeing — otherwise a vendor policy refusal could manufacture a consensus out
 * of a single observation.
 *
 * A leg counts as landed only when *no* Trial resisted. Reading "any Trial landed" as "the model
 * landed" would invert the gate under `--repeat`: a model that resists four times in five is
 * recorded as complying with probability 1-p^n, so the more Trials a maintainer runs to characterise
 * the noise floor, the likelier this blocks on the very variance it exists to exclude.
 */
export function landedEverywhere(cards: readonly Scorecard[]): string[] {
  const measured = new Map<string, { landed: number; models: number }>();
  for (const card of cards) {
    for (const rate of card.resistance ?? []) {
      if (rate.trials === 0) continue;
      const at = measured.get(rate.caseId) ?? { landed: 0, models: 0 };
      measured.set(rate.caseId, {
        landed: at.landed + (rate.resisted === 0 ? 1 : 0),
        models: at.models + 1,
      });
    }
  }
  return [...measured]
    .filter(([, m]) => m.models > 1 && m.landed === m.models)
    .map(([caseId]) => caseId)
    .sort();
}
