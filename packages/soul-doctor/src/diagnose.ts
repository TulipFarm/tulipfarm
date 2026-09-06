import { type Finding, finding } from "./finding";
import { lintRoutineDocument } from "./routine-lint";

/** One published Routine as the active bundle holds it. */
export interface PublishedRoutine {
  readonly slug: string;
  /** The bundle's own hash of the authored document. */
  readonly hash: string;
  /** The authored document as parsed, before validation — a hand-edit may not satisfy the schema. */
  readonly document: unknown;
}

export interface BundleState {
  /** Commit the active bundle pins, or `undefined` when nothing has ever published. */
  readonly activeCommitSha: string | undefined;
  /** Current git HEAD of the soul repo. */
  readonly headSha: string | undefined;
  /** Why the last publication attempt failed, when one did. Payload-safe text only. */
  readonly lastPublicationError?: string;
  readonly routines: readonly PublishedRoutine[];
}

/**
 * Reports the soul repo having moved past the bundle the Runtime serves.
 *
 * Publication is all-or-nothing and its failure is only logged, so one unpublishable artifact
 * freezes *every* artifact at the last good commit. The repo then says one thing and the Runtime
 * runs another, with nothing in any product surface to say so — which is the same invisibility
 * that made the original incident cost a person an afternoon.
 */
function stalenessFindings(state: BundleState): readonly Finding[] {
  const { activeCommitSha, headSha } = state;
  if (headSha === undefined || activeCommitSha === undefined) return [];
  if (activeCommitSha === headSha) return [];
  return [
    finding({
      code: "bundle_stale",
      severity: "broken",
      subject: { kind: "soul", id: "bundle", digest: activeCommitSha },
      at: headSha,
      detail:
        `The Runtime serves the bundle for commit \`${activeCommitSha}\`, but the soul repo is at ` +
        `\`${headSha}\`. Publication has not caught up, so every edit since is inert.` +
        (state.lastPublicationError === undefined
          ? ""
          : ` Last publication error: ${state.lastPublicationError}`),
    }),
  ];
}

/**
 * Every defect the Doctor can prove without a model, a fixture, or a live port.
 *
 * Deliberately whole-bundle rather than incremental: a sweep that only re-checks what changed
 * cannot see a Routine broken by an *unrelated* edit, and the whole pass is a compile per Routine.
 */
export function diagnoseSoul(state: BundleState): readonly Finding[] {
  return [
    ...stalenessFindings(state),
    ...state.routines.flatMap((published) =>
      lintRoutineDocument({
        slug: published.slug,
        digest: published.hash,
        document: published.document,
      })
    ),
  ];
}
