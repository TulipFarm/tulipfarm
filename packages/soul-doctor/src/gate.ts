import type { Finding } from "./finding";

/**
 * A repair's proposed change, as the Doctor sees it before anything is published.
 *
 * `paths` are soul-repo paths, so "did this touch more than the artifact the finding named" is a
 * question about the diff itself rather than about the model's account of the diff.
 */
export interface ProposedRepair {
  readonly fingerprint: string;
  readonly paths: readonly string[];
  /** The repaired artifact's text, already written by the repair Run but not yet published. */
  readonly content: string;
  /** Whether the repaired artifact compiles and lints clean. Proved by re-running the lint. */
  readonly lintsClean: boolean;
  /** One line naming what changed, for the activity feed and the Task. */
  readonly summary?: string;
}

export type GateVerdict =
  | { readonly decision: "publish" }
  | { readonly decision: "propose"; readonly because: string };

/**
 * Fields whose appearance in a repaired artifact takes it out of auto-publish.
 *
 * These are the levers that decide what a Run may *do* rather than what it computes. A model that
 * is wrong about a field name costs a failed Run; a model that is wrong about an identity ceiling
 * or a secret reference costs something that cannot be taken back, and no simulator proves that
 * one safe. The list is deliberately shallow and textual: it is a tripwire, not an analysis, and a
 * tripwire that fires on a mention is the right kind of wrong.
 */
const SENSITIVE_FIELDS: readonly string[] = [
  "secret://",
  "credentialRef",
  "identity",
  "permissionCeiling",
  "principalId",
  "principalKind",
  "maxRiskClass",
  "grants",
  "approval",
  "requiresApproval",
];

/** How many times one defect may be repaired before it becomes a person's problem. */
export const MAX_REPAIR_ATTEMPTS = 2;

export interface GateInput {
  readonly finding: Finding;
  readonly repair: ProposedRepair;
  /** The artifact path the finding's subject owns; a diff may not reach outside it. */
  readonly subjectPath: string;
  /** Attempts already recorded against this fingerprint, including the one being decided. */
  readonly attempts: number;
  /** Text of the artifact before the repair, so the gate can see what the diff introduced. */
  readonly before: string;
}

/**
 * Decides whether a repair publishes itself or waits for a person.
 *
 * The thing being trusted here is the lint, not the model: every condition is something provable
 * about the proposed bytes. A repair that clears all of them changes one artifact, in a way that
 * compiles, without touching authority — which is the narrow class where waiting for a click buys
 * nothing and costs an outage.
 */
export function gateRepair(input: GateInput): GateVerdict {
  const { finding, repair, subjectPath, attempts, before } = input;
  if (finding.severity !== "broken") {
    return { decision: "propose", because: "the defect is not proved, only suspected" };
  }
  if (!repair.lintsClean) {
    return { decision: "propose", because: "the repaired artifact does not lint clean" };
  }
  if (attempts > MAX_REPAIR_ATTEMPTS) {
    return {
      decision: "propose",
      because: `this defect has already been repaired ${MAX_REPAIR_ATTEMPTS} times without sticking`,
    };
  }
  const outside = repair.paths.filter((path) => path !== subjectPath);
  if (outside.length > 0) {
    return {
      decision: "propose",
      because: `the repair also changes ${outside.join(", ")}, outside the artifact the finding names`,
    };
  }
  // Only *newly introduced* sensitive text blocks the publish. A Routine that already carried a
  // `credentialRef` would otherwise be un-repairable forever, which turns the safest artifacts
  // into the ones the Doctor can never help.
  const introduced = SENSITIVE_FIELDS.filter(
    (field) => repair.content.includes(field) && !before.includes(field)
  );
  if (introduced.length > 0) {
    return {
      decision: "propose",
      because: `the repair introduces ${introduced.join(", ")}, which decides what a Run may do`,
    };
  }
  return { decision: "publish" };
}
