import { HookExecutor, resolveHookWorkerPath } from "@tulipfarm/sandbox";

/**
 * Spawn the API's hook sandbox.
 *
 * The isolate itself belongs to `@tulipfarm/sandbox`; what stays here is the one capability this
 * application grants it — a connection to the resource tables, so `ctx.resources.get(...)` can
 * read a record. The Worker spawns the same sandbox with no such connection, and the difference
 * is exactly this call site rather than a flag buried inside the sandbox.
 *
 * `roleOptions` carries the runtime role pinning from {@link runtimePoolOptions}. This thread
 * serves *user-authored* hook code, so it is the connection that most needs to be a non-superuser
 * one — but it cannot reuse the main pool across a worker boundary, and it must not guess the role
 * name, because pinning a role that does not exist fails the connection.
 */
export function createHookExecutor(connectionString: string, roleOptions?: string): HookExecutor {
  return new HookExecutor({
    workerPath: resolveHookWorkerPath(__dirname, "hook-worker"),
    workerData: { connectionString, roleOptions },
  });
}
