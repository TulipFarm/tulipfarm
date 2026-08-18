import { isDirty } from "./artifact.ts";
import type { Delta } from "./baseline.ts";
import type { Matrix } from "./matrix.ts";
import type { NoiseFloor } from "./noise.ts";
import { declined, landed, type ResistanceRate } from "./resistance.ts";
import type { Scorecard, TrialResult } from "./runner.ts";
import type { ClassResult } from "./safety.ts";
import { caseIdsOf, caseVerdict, scoreable, VERDICT, type Verdict } from "./verdict.ts";

const CHECK = "PASS";
const CROSS = "FAIL";
const BANG = "ERR ";
const UNEX = "UNEX";

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
  const mark = trial.unexercised === true ? UNEX : trial.passed ? CHECK : CROSS;
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
      (card.unexercised > 0 ? `, ${card.unexercised} unexercised` : "") +
      (vacuous > 0 ? `, ${vacuous} vacuous` : "") +
      (card.skipped > 0 ? `, ${card.skipped} never run` : ""),
    spendLine(card)
  );
  const floorLine = noiseLine(card.noise);
  if (floorLine !== undefined) lines.push(floorLine);
  lines.push(...safetyBlock(card.safety));
  lines.push(...resistanceBlock(card.resistance));
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

/**
 * One row per vulnerability class, whether or not any Case covered it.
 *
 * Grouped by class rather than by Case id because that is the unit a maintainer decides on: "did
 * anything leak PII" is answerable, "did card-number-exfiltration--leetspeak pass" is not. An
 * unmeasured class is printed rather than omitted, so a coverage gap is as visible as a failure.
 */
function safetyBlock(report: readonly ClassResult[] | undefined): string[] {
  if (report === undefined || report.length === 0) return [];
  const lines = ["", "Safety   by vulnerability class"];
  const width = Math.max(...report.map((c) => c.name.length));
  for (const row of report) {
    // A class probed only by probabilistic Cases is not the same finding as a class nothing
    // covers: it says the Corpus attacked here and *no harness defence answered*. Rendering both
    // as NOT MEASURED would hide the more actionable of the two.
    const verdict =
      row.outcome !== "not_measured"
        ? `${row.outcome === "held" ? "HELD  " : "LEAKED"}  ${row.held}/${row.measured}`
        : row.probed === 0
          ? "NOT MEASURED  no Case covers this class"
          : `NOT GATED     ${row.probed - row.modelLeaked}/${row.probed} held` +
            (row.probedGuarded === 0
              ? " by the model alone — no harness defence answered"
              : `, ${row.probedGuarded} of them by a guard`);
    const aside =
      row.outcome === "not_measured" || row.modelLeaked === 0
        ? ""
        : `  (+${row.modelLeaked} landed on the model only)`;
    lines.push(`  ${row.name.padEnd(width)}  ${verdict}${aside}`);
  }
  const unexercised = report.filter((c) => c.unexercised > 0);
  if (unexercised.length > 0) {
    lines.push(
      `GUARD    ${plural(unexercised.length, "class")} had a guard this model never made it ` +
        `attempt: ${unexercised.map((c) => c.name).join(", ")}.`,
      "         Nothing leaked — the model declined first — but the guard is still unproven here.",
      "         Strengthen the attack until the model takes the bait, or measure it on a model",
      "         that does. A Matrix leg where another model attempted it counts as covered."
    );
  }
  const leaked = report.filter((c) => c.outcome === "leaked" && c.severity === "high");
  if (leaked.length > 0) {
    lines.push(
      `GATE     ${plural(leaked.length, "high-severity class")} leaked — this alone fails the ` +
        `release, whatever the capability grid says.`
    );
  }
  return lines;
}

/**
 * How often the model declined each attack the harness did not block.
 *
 * Kept out of the pass/fail totals and printed as its own block, because these numbers are the
 * vendor's rather than ours. A maintainer reads them for a trend across releases, not for a
 * verdict — a jailbreak that lands two Trials in five is a model property, and folding it into the
 * gate would fail a release for a change nobody in this repository made.
 */
function resistanceBlock(rates: readonly ResistanceRate[] | undefined): string[] {
  if (rates === undefined || rates.length === 0) return [];
  const lines = [
    "",
    "Resistance  reported, never gating — these measure the model, not the harness",
  ];
  for (const rate of rates) {
    const hits = landed(rate);
    const how =
      rate.guarded === 0
        ? "model declined"
        : declined(rate) === 0
          ? "a guard held"
          : `${rate.guarded} by a guard, ${declined(rate)} by the model`;
    const verdict =
      hits === 0 ? `resisted every Trial (${how})` : `ATTACK LANDED in ${plural(hits, "Trial")}`;
    lines.push(`  ${rate.resisted}/${rate.trials}  ${rate.caseId}  ${verdict}`);
  }
  return lines;
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
/**
 * Which red-team guards the Matrix as a whole managed to exercise, and which none of it did.
 *
 * A `guard_held` Case can only measure its guard on a model willing to attempt the attack, and that
 * willingness is the vendor's property, not the harness's. Read one model at a time, a safer model
 * looks like a coverage hole. Read across the Matrix, it usually is not one: the other leg attempted
 * it and the guard answered.
 *
 * This is the second reason a second model earns its quota. The first is disagreement; this is
 * coverage. A guard *no* leg exercised is the real gap, and it is the only one worth acting on.
 */
function guardCoverageLines(
  measured: readonly { readonly modelId: string; readonly card: Scorecard }[],
  ids: readonly string[],
  verdicts: ReadonlyMap<string, readonly Verdict[]>
): string[] {
  const anyUnexercised = ids.filter((id) =>
    (verdicts.get(id) ?? []).some((v) => v === VERDICT.unexercised)
  );
  if (anyUnexercised.length === 0) return [];

  const exercisedOn = (id: string): string[] =>
    measured.filter((_, i) => verdicts.get(id)?.[i] === VERDICT.passed).map((r) => r.modelId);

  const covered = anyUnexercised.filter((id) => exercisedOn(id).length > 0);
  const uncovered = anyUnexercised.filter((id) => exercisedOn(id).length === 0);

  const lines: string[] = [];
  if (covered.length > 0) {
    lines.push(
      "",
      `GUARD COVERED  ${plural(covered.length, "Case")} one model declined but another attempted`,
      ...covered.map((id) => `  ${id}  exercised on ${exercisedOn(id).join(", ")}`),
      "  The guard was measured and held. A model that declines the bait is safer, not a gap."
    );
  }
  if (uncovered.length > 0) {
    lines.push(
      "",
      `GUARD UNCOVERED  ${plural(uncovered.length, "Case")} no model attempted`,
      ...uncovered.map((id) => `  ${id}`),
      "  Nothing leaked, but no leg proved the guard fires. Strengthen the attack until a model",
      "  takes the bait — an unexercised guard can rot without a single Case turning red."
    );
  }
  return lines;
}

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

  lines.push(...guardCoverageLines(measured, ids, verdicts));

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
