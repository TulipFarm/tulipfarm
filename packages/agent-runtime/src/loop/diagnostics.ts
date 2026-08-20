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
 * Whether a Tool result is `request_input` asking the Run to suspend.
 *
 * The name alone is not enough: the Tool can answer without needing anybody, and only the
 * `suspendRun` flag distinguishes a question that parks the Run from one that did not have to.
 */
export function isInputRequired(name: string, output: unknown): boolean {
  return (
    name === "request_input" &&
    typeof output === "object" &&
    output !== null &&
    (output as { suspendRun?: unknown }).suspendRun === true
  );
}
