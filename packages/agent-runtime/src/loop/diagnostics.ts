/** Failure shapes and predicates the Tool loop needs but whose logic is not the loop's. */

/** Event-sink failures rethrow as sink failures, not model failures. */
export class EventSinkFailure extends Error {
  constructor(readonly cause: unknown) {
    super("event sink failed");
  }
}

/** Walks `.cause` to the innermost diagnostic message. */
export function deepestErrorMessage(diagnostic: unknown): string {
  let current = diagnostic;
  while (current instanceof Error && current.cause !== undefined) current = current.cause;
  return current instanceof Error ? current.message : String(current);
}

/**
 * The Tool that puts a question to the operator and stops the Turn on it.
 *
 * The loop knows it by name rather than by what it answered. A barrier read off the result — the
 * `suspendRun` flag the Tool sets when the question reached a Surface — held only while the call
 * succeeded, so every other outcome (rejected props, a denial, a ledger replay) came back as
 * ordinary Tool feedback and the model went on to take the very action the question existed to
 * gate (#405). Asking is what stops the Turn; being answered is not this loop's evidence to weigh.
 */
export const REQUEST_INPUT_TOOL = "request_input";
