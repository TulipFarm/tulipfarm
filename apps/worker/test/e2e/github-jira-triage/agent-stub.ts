import type { CompiledState } from "@tulipfarm/run-kernel";
import { ajv } from "@tulipfarm/schema";
import { authored, record, type TriageClassification } from "./fixtures";

/**
 * The Agent step, stubbed. The tests decide what the model "concluded"; this turns that into the
 * State output the rest of the Run consumes.
 *
 * Two rules make the stub worth having rather than just returning the fixture. Assignees are
 * resolved through the directory, so a classification can only ever name people the directory
 * knows — prompt text cannot pick an arbitrary GitHub login. And the output is checked against the
 * State's authored schema before any provider call, so a malformed Agent answer fails here rather
 * than reaching a provider.
 */

/** Agent outputs account ids, not GitHub logins, so prompt text cannot pick assignees. */
const DIRECTORY: Readonly<Record<string, string>> = {
  "acct-maya": "maya-dev",
  "acct-lee": "lee-dev",
};

/** Agent stub proposes only; directory resolution prevents arbitrary GitHub assignees. */
export function classifyIssue(
  classification: TriageClassification,
  state: CompiledState
): Record<string, unknown> {
  const assignees = classification.candidateAccountIds
    .slice(0, 1)
    .map((accountId) => DIRECTORY[accountId])
    .filter((login): login is string => login !== undefined);

  const output: Record<string, unknown> = {
    duplicate: classification.duplicate,
    labels: [...classification.labels],
    summary: classification.summary,
    reply: classification.reply,
    candidateAccountIds: [...classification.candidateAccountIds],
    assignees,
  };
  if (classification.duplicateOfIssue !== undefined) {
    output.duplicateOfIssue = classification.duplicateOfIssue;
  }

  // Authored output schema is the boundary, before any provider call.
  const schema = authored(state).output;
  if (schema !== undefined && !ajv.compile(record(schema))(output)) {
    throw new Error(`ClassifyIssue produced output outside its declared schema`);
  }
  return output;
}
