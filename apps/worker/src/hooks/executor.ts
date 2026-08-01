import { HookExecutor, resolveHookWorkerPath } from "@tulipfarm/sandbox";

/**
 * Spawn the Worker's hook sandbox.
 *
 * Same isolate as the API's, spawned with no capabilities at all — see `ingress-hook-worker.ts`
 * for why. `resolveHookWorkerPath` picks the bundled `.cjs` sibling in an image and the `.ts`
 * source under tsx in dev, so the same call works in both without either knowing how the other is
 * built.
 *
 * The basename is *not* the API's. Both entrypoints are bundled flat into the same image
 * directory, so sharing a name would silently hand this process the API's grant — a classifier
 * with a connection to the resource tables — and nothing would look wrong.
 */
export function createHookExecutor(): HookExecutor {
  return new HookExecutor({ workerPath: resolveHookWorkerPath(__dirname, "ingress-hook-worker") });
}
