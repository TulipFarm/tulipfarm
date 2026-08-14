import { HookExecutor, resolveHookWorkerPath } from "@tulipfarm/sandbox";

/** Spawn the no-grant classifier isolate; keep its basename distinct from the API bundle. */
export function createHookExecutor(): HookExecutor {
  return new HookExecutor({ workerPath: resolveHookWorkerPath(__dirname, "ingress-hook-worker") });
}
