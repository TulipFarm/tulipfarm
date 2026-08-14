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

/** Apps pass only the capabilities their isolate may receive; the shared host grants no extras. */
export function serveHookRequests(options: HookWorkerHostOptions = {}): void {
  parentPort?.on("message", async (request: WorkerRequest) => {
    if ((request as unknown as { type?: string }).type === "shutdown") {
      await options.shutdown?.();
      process.exit(0);
    }
    parentPort?.postMessage(await handleHookRequest(request, options));
  });
}
