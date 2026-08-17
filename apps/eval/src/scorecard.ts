import { isDirty } from "./artifact.ts";
import type { Delta } from "./baseline.ts";
import type { Matrix } from "./matrix.ts";
import type { NoiseFloor } from "./noise.ts";
import type { Scorecard, TrialResult } from "./runner.ts";
import { caseIdsOf, caseVerdict, scoreable, VERDICT } from "./verdict.ts";

const CHECK = "PASS";
const CROSS = "FAIL";
const BANG = "ERR ";

/**
 * What the Sweep spent, and how much of that it cannot see.
 *
 * An unpriced call is reported separately rather than folded into the total: it contributed real
 * money and zero dollars, so a total that hides it reads as a smaller bill than was paid.
 */
function spendLine(card: Scorecard): string {
  const { spend } = card;
  const cached = spend.cacheReadTokens > 0 ? ` (${spend.cacheReadTokens} cached)` : "";
  const unpriced = spend.unpriced > 0 ? `  ${spend.unpriced} unpriced` : "";
  const seat = spend.subscription > 0 ? `  ${spend.subscription} on a seat` : "";
  return (
    `Spend  $${spend.costUsd.toFixed(4)}${spend.unpriced > 0 ? "+" : ""}  ` +
    `${spend.calls} calls  ${spend.inputTokens} in${cached}  ${spend.outputTokens} out` +
    `${unpriced}${seat}`
  );
}

function describe(trial: TrialResult): string {
  if (trial.error !== undefined) return `${BANG} ${trial.caseId}#${trial.trial}  ${trial.error}`;
  const mark = trial.passed ? CHECK : CROSS;
  const note = trial.vacuous ? "  (vacuous)" : "";
  const retried = trial.retries > 0 ? `  (${trial.retries} retried)` : "";
  return `${mark} ${trial.caseId}#${trial.trial}  [${trial.status}]${note}${retried}`;
}

/**
 * Render a Scorecard as plain text.
 *
 * The Corpus hash and model id lead, because a Scorecard read without them invites the exact
 * comparison the framework exists to prevent: two numbers produced by different inputs.
 */
export function renderScorecard(card: Scorecard): string {
  const version = card.modelVersion === undefined ? "" : `  version=${card.modelVersion}`;
  const effort = card.effort === undefined ? "" : `  effort=${card.effort}`;
  const lines: string[] = [
    "",
    `Sweep  model=${card.modelId}${version}${effort}  ` +
      `corpus=${card.corpusHash.slice(0, 16)}  ${card.durationMs}ms`,
    "",
  ];

  for (const trial of card.trials) {
    lines.push(describe(trial));
    if (trial.error !== undefined) continue;
    for (const expectation of trial.expectations) {
      if (expectation.passed) continue;
      lines.push(`     - ${expectation.expectation.kind}: ${expectation.detail}`);
    }
  }

  const vacuous = card.trials.filter((t) => t.vacuous).length;
  lines.push(
    "",
    `${card.passed} passed, ${card.failed} failed, ${card.errored} errored` +
      (vacuous > 0 ? `, ${vacuous} vacuous` : "") +
      (card.skipped > 0 ? `, ${card.skipped} never run` : ""),
    spendLine(card)
  );
  const floorLine = noiseLine(card.noise);
  if (floorLine !== undefined) lines.push(floorLine);
  // An alias is all a subscription seat offers. Saying so keeps a Scorecard from implying the
  // vendor could not have moved the model between this Sweep and the one it is compared against.
  if (!card.modelDated) {
    lines.push(`NOTE     "${card.modelId}" is a vendor alias, not a dated pin — it may move.`);
  }
  // A Sweep that stopped early measured part of the Corpus. Saying so on the last line keeps it
  // from being read as a clean result that happened to be short.
  if (card.abortedReason !== undefined) lines.push(`ABORTED  ${card.abortedReason}`);
  lines.push("");
  return lines.join("\n");
}

/**
 * What the Sweep's own repeats revealed about how much it moves on its own.
 *
 * Printed beside the totals rather than buried, because it is the number that says how much of the
 * rest of the Scorecard to believe.
 */
function noiseLine(floor: NoiseFloor | undefined): string | undefined {
  if (floor === undefined) return undefined;
  if (floor.repeats < 2) {
    return `Noise    NOT MEASURED  at least one Case ran once, so the Corpus was not repeated`;
  }
  const over = `over ${floor.repeats} repeats of ${plural(floor.measured, "Case")}`;
  if (floor.flapping.length === 0) return `Noise    0 Cases flapped ${over} — deltas are signal`;
  return (
    `Noise    ${plural(floor.flapping.length, "Case")} flapped ${over}: ` +
    `${floor.flapping.join(", ")} — a move on these is not signal`
  );
}

/** Case ids in first-seen order across every model, so an aborted Sweep still contributes its own. */
function caseIds(matrix: Matrix): string[] {
  const seen: string[] = [];
  for (const run of matrix.runs) {
    for (const id of run.card === undefined ? [] : caseIdsOf(run.card)) {
      if (!seen.includes(id)) seen.push(id);
    }
  }
  return seen;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function pad(text: string, width: number): string {
  return text.padEnd(width, " ");
}

/**
 * Render a Matrix: one Corpus, several models, side by side.
 *
 * The grid leads because the cross-model pattern is the thing a second model was added to reveal.
 * Each model's own Scorecard follows unchanged, so a failure stays as debuggable as it is in a
 * single-model Sweep.
 */
export function renderMatrix(matrix: Matrix): string {
  const ids = caseIds(matrix);
  const models = matrix.runs.map((r) => r.modelId);
  const caseWidth = Math.max(4, ...ids.map((id) => id.length));
  const widths = models.map((m) => Math.max(m.length, VERDICT.unavailable.length));

  const lines: string[] = [
    "",
    `Matrix  corpus=${matrix.corpusHash.slice(0, 16)}  ${plural(models.length, "model")}  ${matrix.durationMs}ms`,
  ];

  // A header row over no rows reads as an empty result rather than as a run that never started.
  if (ids.length === 0) {
    lines.push("", "No Case was measured — see each model below for why.");
  } else {
    lines.push(
      "",
      `${pad("Case", caseWidth)}  ${models.map((m, i) => pad(m, widths[i] ?? m.length)).join("  ")}`
    );
    for (const id of ids) {
      const cells = matrix.runs.map((run, i) =>
        pad(
          run.card === undefined ? VERDICT.unavailable : caseVerdict(run.card, id),
          widths[i] ?? 0
        )
      );
      lines.push(`${pad(id, caseWidth)}  ${cells.join("  ")}`);
    }
  }

  lines.push(...disagreementLines(matrix, ids));

  for (const run of matrix.runs) {
    if (run.card === undefined) {
      lines.push("", `${run.modelId}  NOT MEASURED  ${run.unavailable ?? "no reason given"}`);
      continue;
    }
    lines.push(renderScorecard(run.card).replace(/\n$/, ""));
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Name the Cases the models landed on differently.
 *
 * This is the only reason a second model is worth its quota: a Case that passes on one and fails
 * on the other says the harness change under test is model-specific. The note is spelled out
 * because a two-column grid reads as a scoreboard unless it says otherwise, and a maintainer who
 * reads it that way will pick a model instead of fixing the harness.
 *
 * Only Cases every measured model actually scored can be compared. A Case one model errored on, or
 * never reached because its ceiling stopped the Sweep, is reported as not comparable — calling it
 * a disagreement would blame the harness for a rate limit or a budget.
 */
function disagreementLines(matrix: Matrix, ids: string[]): string[] {
  const measured = matrix.runs.filter(
    (r): r is typeof r & { card: Scorecard } => r.card !== undefined
  );
  if (measured.length < 2) return [];

  const verdicts = new Map(ids.map((id) => [id, measured.map((r) => caseVerdict(r.card, id))]));
  const comparable = ids.filter((id) => (verdicts.get(id) ?? []).every(scoreable));
  const incomparable = ids.filter((id) => !comparable.includes(id));
  const split = comparable.filter((id) => new Set(verdicts.get(id)).size > 1);

  const detail = (id: string): string =>
    `  ${id}  ${measured.map((r, i) => `${r.modelId}=${verdicts.get(id)?.[i]}`).join("  ")}`;

  const lines: string[] =
    split.length === 0
      ? [
          "",
          `Models agree on all ${plural(comparable.length, "comparable Case")} — this run shows ` +
            "no model-specific harness behaviour.",
        ]
      : [
          "",
          `DISAGREEMENT  ${split.length} of ${plural(comparable.length, "comparable Case")}`,
          ...split.map(detail),
          "  A Case that lands differently on each model is a property of the harness under that model.",
          "  These models are a control on the measurement, not competitors: this is not a ranking.",
        ];

  if (incomparable.length > 0) {
    lines.push(
      "",
      `NOT COMPARABLE  ${incomparable.length} of ${plural(ids.length, "Case")}`,
      ...incomparable.map(detail),
      `  ${VERDICT.errored} is a vendor fault and ${VERDICT.notRun} means the Case never ran. ` +
        "Neither is a verdict on the harness,",
      "  so these Cases are held out of the comparison rather than counted as a disagreement."
    );
  }

  return lines;
}

/**
 * Render a Sweep as a change against its Baseline.
 *
 * A Scorecard alone is an absolute number nobody can act on — 14 of 20 is neither good nor bad. The
 * only question a release asks is whether this harness is worse than the last one, and that is a
 * delta. Regressions lead, because they are the only line that should stop a release.
 */
export function renderDelta(delta: Delta, baselineVersion: string): string {
  const move = (d: (typeof delta.cases)[number]) => `  ${d.caseId}  ${d.before} -> ${d.after}`;
  const of = (change: string) => delta.cases.filter((c) => c.change === change);
  const regressed = of("regressed");
  const fixed = of("fixed");
  const held = of("not-comparable");

  const lines: string[] = [
    "",
    `Delta  model=${delta.modelId}  corpus=${delta.corpusHash.slice(0, 16)}  ` +
      `baseline=${baselineVersion}`,
  ];

  if (regressed.length > 0) {
    lines.push("", `REGRESSED  ${plural(regressed.length, "Case")}`, ...regressed.map(move));
  }
  if (fixed.length > 0) {
    lines.push("", `FIXED  ${plural(fixed.length, "Case")}`, ...fixed.map(move));
  }
  if (held.length > 0) {
    lines.push(
      "",
      `NOT COMPARABLE  ${plural(held.length, "Case")}`,
      ...held.map(move),
      `  ${VERDICT.errored} is a vendor fault and ${VERDICT.notRun} means the Case never ran on ` +
        "one side.",
      "  Neither is a verdict on the harness, so neither counts as a regression."
    );
  }
  const damped = of("no-signal");
  if (damped.length > 0) {
    lines.push(
      "",
      `NO SIGNAL  ${plural(damped.length, "Case")}`,
      ...damped.map(move),
      "  The Baseline's own repeated Trials already disagreed on these, so this movement is",
      "  inside the measured noise floor and is not counted as a change either way."
    );
  }
  if (regressed.length === 0 && fixed.length === 0) {
    lines.push("", "No change against the Baseline on any comparable Case.");
  }
  // A Baseline with no floor damps nothing. Saying so stops a clean delta from being read as
  // evidence of stability when it is only evidence that stability was never measured.
  if (delta.floor === undefined) {
    lines.push(
      "NOTE     Baseline recorded no noise floor, so nothing was damped. " +
        "Promote one with --repeat."
    );
  }

  lines.push("", `${delta.passedBefore} passed before, ${delta.passedAfter} passed after`);
  // A Baseline promoted from a dirty tree names a commit that never existed, so nobody else can
  // reproduce the number this run is being measured against.
  if (isDirty(baselineVersion)) {
    lines.push(
      `WARN     Baseline was promoted from an uncommitted tree (${baselineVersion}) — ` +
        "it is not reproducible."
    );
  }
  lines.push("");
  return lines.join("\n");
}
