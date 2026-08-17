import type { Scorecard, TrialResult } from "./runner.ts";

const CHECK = "PASS";
const CROSS = "FAIL";
const BANG = "ERR ";

function describe(trial: TrialResult): string {
  if (trial.error !== undefined) return `${BANG} ${trial.caseId}#${trial.trial}  ${trial.error}`;
  const mark = trial.passed ? CHECK : CROSS;
  const note = trial.unasserted ? "  (unasserted)" : "";
  return `${mark} ${trial.caseId}#${trial.trial}  [${trial.status}]${note}`;
}

/**
 * Render a Scorecard as plain text.
 *
 * The Corpus hash and model id lead, because a Scorecard read without them invites the exact
 * comparison the framework exists to prevent: two numbers produced by different inputs.
 */
export function renderScorecard(card: Scorecard): string {
  const lines: string[] = [
    "",
    `Sweep  model=${card.modelId}  corpus=${card.corpusHash.slice(0, 16)}  ${card.durationMs}ms`,
    "",
  ];

  for (const trial of card.trials) {
    lines.push(describe(trial));
    if (trial.error !== undefined) continue;
    for (const assertion of trial.assertions) {
      if (assertion.passed) continue;
      lines.push(`     - ${assertion.assertion.kind}: ${assertion.detail}`);
    }
  }

  const unasserted = card.trials.filter((t) => t.unasserted).length;
  lines.push(
    "",
    `${card.passed} passed, ${card.failed} failed, ${card.errored} errored` +
      (unasserted > 0 ? `, ${unasserted} unasserted` : ""),
    ""
  );
  return lines.join("\n");
}
