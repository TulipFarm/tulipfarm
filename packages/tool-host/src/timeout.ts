import { err, type RequestContext, type ToolCallResult, type ToolDef } from "./types";

/** Runs an operation until its deadline, aborting work that has not completed. */
export async function withAbortTimeout<T>(
  execute: (abortSignal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timeoutResult: () => T
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const timedOut = new Promise<T>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve(timeoutResult()), { once: true });
  });
  try {
    return await Promise.race([execute(controller.signal), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** Executes a Tool with a deadline while preserving a per-invocation cancellation signal. */
export function executeToolWithTimeout(
  tool: ToolDef,
  args: unknown,
  context: RequestContext,
  timeoutMs: number
): Promise<ToolCallResult> {
  return withAbortTimeout(
    (abortSignal) => tool.execute(args, { ...context, abortSignal }),
    timeoutMs,
    () => err("internal_error", "tool execution timed out")
  );
}
