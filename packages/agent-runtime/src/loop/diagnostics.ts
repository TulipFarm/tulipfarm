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

/**
 * The Tools that move ownership of the work to somebody else.
 *
 * Naming one is a barrier on the same terms as {@link REQUEST_INPUT_TOOL}: read off the call's
 * identity, never off what came back. A hand-off the deployment cannot perform used to return
 * `tool_not_available` as ordinary feedback, which the model routed around by reporting the
 * hand-off as done — the Turn ended `completed` over work nobody did (#419). `transfer_to_agent`
 * is listed although no host registers it, precisely so a Turn that reaches for it stops instead
 * of narrating.
 */
const HANDOFF_TOOL_NAMES: ReadonlySet<string> = new Set(["transfer_to_agent", "delegate_to_agent"]);

/** Whether this call was an attempt to hand the work on rather than to do it. */
export function isHandoffTool(name: string): boolean {
  return HANDOFF_TOOL_NAMES.has(name);
}
