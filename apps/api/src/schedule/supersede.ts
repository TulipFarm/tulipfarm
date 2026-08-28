import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";

/** The narrow slice of the Run store this needs, so a test does not have to build a whole one. */
export interface ActiveRunLister {
  listActiveByRoutine(input: {
    readonly businessId: string;
    readonly routineId: string;
  }): Promise<readonly string[]>;
}

export type CancelOneRun = (input: {
  readonly businessId: string;
  readonly runId: string;
  readonly reason: string;
  readonly inFlightEffects: Readonly<Record<string, readonly string[]>>;
  readonly now: string;
}) => Promise<unknown>;

/**
 * Cancel every unfinished Run of a Routine, for `overlapPolicy: "supersede"`.
 *
 * Cancellation parks in-flight effects rather than abandoning them, so a superseded Run stops
 * without pretending work that already reached a provider never happened. One Run that refuses to
 * cancel fails the whole call: the caller must not start a replacement it cannot replace.
 */
export async function supersedeRoutineRuns(
  runs: ActiveRunLister,
  cancel: CancelOneRun,
  routineId: string,
  now: () => string = () => new Date().toISOString()
): Promise<void> {
  const active = await runs.listActiveByRoutine({
    businessId: DEPLOYMENT_BUSINESS_ID,
    routineId,
  });
  for (const runId of active) {
    await cancel({
      businessId: DEPLOYMENT_BUSINESS_ID,
      runId,
      reason: "superseded_by_schedule",
      inFlightEffects: {},
      now: now(),
    });
  }
}
