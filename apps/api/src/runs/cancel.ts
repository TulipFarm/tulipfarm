import { CancellationError, type RunCancellationManager } from "@tulipfarm/run-kernel";
import type { ChatRunCanceller } from "../chat/routes";

/** Missing or closed Runs map to idempotent stop success. */
export function runCanceller(
  manager: Pick<RunCancellationManager, "cancel">,
  terminalTurns?: { reconcileRun(businessId: string, runId: string): Promise<boolean> }
): ChatRunCanceller {
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
      } catch (error) {
        if (
          error instanceof CancellationError &&
          (error.code === "run_not_found" || error.code === "run_not_cancellable")
        ) {
          return false;
        }
        throw error;
      }
      await terminalTurns?.reconcileRun(businessId, runId).catch(() => false);
      return true;
    },
  };
}
