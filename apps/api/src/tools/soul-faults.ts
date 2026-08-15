import { err, type ToolCallResult, type ToolErrorCode } from "@tulipfarm/tool-host";

/**
 * Classifies a failure raised while committing to the Soul git tree. `s6-taxonomy` split
 * `ToolErrorCode` into deterministic *business* faults and transient *infrastructure* ones so the
 * chat dispatcher could retry the second kind instead of handing the model prose about it. That
 * split only pays for itself where something actually produces an infrastructure fault — and until
 * this helper existed, nothing on the platform-Tool path did.
 */
const TRANSIENT_GIT_PATTERNS: readonly RegExp[] = [
  /index\.lock/i,
  /unable to create '[^']*\.lock'/i,
  /could not lock config file/i,
  /cannot lock ref/i,
  /reference already exists/i,
  /another git process seems to be running/i,
];

export function isTransientGitFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return TRANSIENT_GIT_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * The fault class a Soul commit failure should carry. Defaults to `internal_error` — the catch-all
 * is *business* on purpose, because widening it would make most failures retry twice for nothing.
 * Only a recognized contention pattern is promoted.
 */
export function soulCommitFaultCode(error: unknown): ToolErrorCode {
  return isTransientGitFailure(error) ? "unavailable" : "internal_error";
}

/** `err()` for a Soul commit failure, carrying the right fault class. */
export function soulCommitError(error: unknown, message: string): ToolCallResult {
  return err(soulCommitFaultCode(error), message);
}
