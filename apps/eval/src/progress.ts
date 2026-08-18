import type { TrialResult } from "./runner.ts";

/**
 * What a Sweep has reached, reported as it happens rather than in the Scorecard.
 *
 * A Trial against a real seat takes seconds, and a Corpus of them takes minutes. Without this the
 * command prints nothing at all until it is over, which is indistinguishable from a hung process —
 * and the first thing an operator does to a hung process is kill it, losing the quota already spent.
 */
export type SweepProgress =
  | {
      readonly kind: "sweep-start";
      readonly modelId: string;
      readonly cases: number;
      readonly planned: number;
    }
  | {
      readonly kind: "trial-start";
      readonly caseId: string;
      readonly trial: number;
      readonly index: number;
      readonly planned: number;
    }
  | { readonly kind: "trial-end"; readonly result: TrialResult }
  | { readonly kind: "sweep-aborted"; readonly reason: string };

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** `ERR`, `VAC` and `UNEX` are not verdicts on the Case; they must not read as one mid-run either. */
function verdictOf(result: TrialResult): string {
  if (result.error !== undefined) return "ERR";
  if (result.vacuous) return "VAC";
  if (result.unexercised === true) return "UNEX";
  return result.passed ? "PASS" : "FAIL";
}

/**
 * Report a Sweep's progress to a stream as it runs.
 *
 * Writes the Case id *before* the call so the operator sees which Case is in flight, then closes
 * the same line with the verdict. This goes to stderr, never stdout: the Scorecard is the artifact
 * a release reads, and progress chatter interleaved into it would corrupt anything parsing it.
 */
export function progressReporter(
  write: (text: string) => void,
  now: () => number = () => Date.now()
): (event: SweepProgress) => void {
  let startedAt = now();

  return (event) => {
    switch (event.kind) {
      case "sweep-start":
        write(`\n${event.modelId}  ${event.cases} Cases, ${event.planned} Trials\n`);
        return;
      case "trial-start":
        startedAt = now();
        write(`  [${event.index}/${event.planned}] ${event.caseId}#${event.trial} … `);
        return;
      case "trial-end": {
        const retries = event.result.retries > 0 ? `  ${event.result.retries} retried` : "";
        write(`${verdictOf(event.result)}  ${seconds(now() - startedAt)}${retries}\n`);
        return;
      }
      case "sweep-aborted":
        write(`  stopped early: ${event.reason}\n`);
        return;
    }
  };
}
