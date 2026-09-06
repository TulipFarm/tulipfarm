/**
 * What SoulRepair returns.
 *
 * Whole-file rather than a patch: the caller has to lint the result before it can be trusted, and
 * linting means compiling the finished artifact anyway. A patch would add a merge step whose
 * failure mode — an applied hunk that lands somewhere unintended — is exactly what the gate's
 * "one artifact, nothing else" rule exists to prevent.
 */
export interface SoulRepairProposal {
  /** The complete repaired artifact. Empty when `repairable` is false. */
  content: string;
  /** One line an operator reads to decide whether the change is the one they wanted. */
  summary: string;
  /** False when the finding cannot be fixed from the artifact alone; `content` is then ignored. */
  repairable: boolean;
}

export const SOUL_REPAIR_PROPOSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["content", "summary", "repairable"],
  properties: {
    content: { type: "string" },
    summary: { type: "string" },
    repairable: { type: "boolean" },
  },
} as const;
