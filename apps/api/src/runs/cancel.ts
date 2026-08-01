import { CancellationError, type RunCancellationManager } from "@tulipfarm/run-kernel";
import type { ChatRunCanceller } from "../chat/routes";

/**
 * Adapts kernel cancellation to the yes/no answer a stop control needs.
 *
 * A Run that is gone or already finished is not an error to report to the person who pressed stop —
 * the turn they wanted stopped is not running. Every other denial is a real fault and is raised.
 *
 * `inFlightEffects` is empty because this process has no view of them: the Worker dispatches Tools,
 * so it is the Worker that knows an effect is outstanding, and a State holding one is parked for
 * reconciliation by the Run's own executor rather than by the request that asked for the stop.
 */
export function runCanceller(manager: Pick<RunCancellationManager, "cancel">): ChatRunCanceller {
  return {
    cancel: async ({ businessId, runId, reason }) => {
      try {
        await manager.cancel({
          businessId,
          runId,
          reason,
          inFlightEffects: {},
          now: new Date().toISOString(),
        });
        return true;
      } catch (error) {
        if (
          error instanceof CancellationError &&
          (error.code === "run_not_found" || error.code === "run_not_cancellable")
        ) {
          return false;
        }
        throw error;
      }
    },
  };
}
