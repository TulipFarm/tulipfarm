/** Shared persistence error, thrown by Run, State, and Attempt storage across `run-store.ts`. */
export type RunPersistenceErrorCode = "attempt_conflict" | "invalid_cursor" | "state_conflict";

export class RunPersistenceError extends Error {
  readonly name = "RunPersistenceError";

  constructor(readonly code: RunPersistenceErrorCode) {
    super(code);
  }
}
