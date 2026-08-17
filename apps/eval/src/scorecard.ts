import type { Scorecard, TrialResult } from "./runner.ts";

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
