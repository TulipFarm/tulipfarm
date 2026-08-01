import { HookExecutor, resolveHookWorkerPath } from "@tulipfarm/sandbox";

/**
 * Spawn the API's hook sandbox.
 *
 * The isolate itself belongs to `@tulipfarm/sandbox`; what stays here is the one capability this
 * application grants it — a connection to the resource tables, so `ctx.resources.get(...)` can
 * read a record. The Worker spawns the same sandbox with no such connection, and the difference
 * is exactly this call site rather than a flag buried inside the sandbox.
 */
export function createHookExecutor(connectionString: string): HookExecutor {
  return new HookExecutor({
    workerPath: resolveHookWorkerPath(__dirname, "hook-worker"),
    workerData: { connectionString },
  });
}
