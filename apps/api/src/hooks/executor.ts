import { HookExecutor, resolveHookWorkerPath } from "@tulipfarm/sandbox";

/** API hook sandbox grants resource-table access and preserves runtime role pinning. */
export function createHookExecutor(connectionString: string, roleOptions?: string): HookExecutor {
  return new HookExecutor({
    workerPath: resolveHookWorkerPath(__dirname, "hook-worker"),
    workerData: { connectionString, roleOptions },
  });
}
