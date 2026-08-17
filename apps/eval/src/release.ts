import { baselinePath, buildArtifact, isDirty, readArtifact, writeArtifact } from "./artifact.ts";
import { compareToBaseline } from "./baseline.ts";
import type { Scorecard } from "./runner.ts";
import { renderDelta } from "./scorecard.ts";
import { caseIdsOf } from "./verdict.ts";

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

  const path = options.baseline ?? baselinePath(options.root, card.modelId);

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
    const target = baselinePath(options.root, card.modelId);
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
