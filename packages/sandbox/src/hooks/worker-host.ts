import { parentPort } from "node:worker_threads";
import { type ResourceLookup, runExpression, runResourceHook, runRoutineHook } from "./isolate";
import type { WorkerRequest, WorkerResponse } from "./protocol";

export interface HookWorkerHostOptions {
  /** The one reach out of the isolate a resource hook gets; omitted means no reach at all. */
  readonly resourceLookup?: ResourceLookup;
  /** Release host resources (pools, handles) before the thread exits. */
  readonly shutdown?: () => Promise<void>;
}

/** Dispatch one request to the isolate runner its `kind` names. */
export async function handleHookRequest(
  request: WorkerRequest,
  options: HookWorkerHostOptions = {}
): Promise<WorkerResponse> {
  if (request.kind === "expression") return runExpression(request);
  if (request.kind === "routine-hook") return runRoutineHook(request);
  return runResourceHook(request, options.resourceLookup);
}

/**
 * Serve isolate requests on the worker thread's port until the host asks it to stop.
 *
 * Each application supplies its own entrypoint module that calls this with the capabilities it is
 * willing to grant, so the isolate logic exists once while an app can never accidentally hand an
 * isolate a reach it did not mean to.
 */
export function serveHookRequests(options: HookWorkerHostOptions = {}): void {
  parentPort?.on("message", async (request: WorkerRequest) => {
    if ((request as unknown as { type?: string }).type === "shutdown") {
      await options.shutdown?.();
      process.exit(0);
    }
    parentPort?.postMessage(await handleHookRequest(request, options));
  });
}
