import { err, type ToolCallResult, type ToolErrorCode } from "./types";

/**
 * Classifies a failure raised while committing to the Soul git tree.
 *
 * `s6-taxonomy` split `ToolErrorCode` into deterministic *business* faults and transient
 * *infrastructure* ones so the chat dispatcher could retry the second kind instead of handing the
 * model prose about it. That split only pays for itself where something actually produces an
 * infrastructure fault — and until this helper existed, nothing on the platform-Tool path did.
 * Every Soul-writing Tool caught its git failure as `internal_error`, which is *business*, so the
 * commonest transient failure in the product was reported to the model as a request it should
 * repair. It cannot: the model has no way to reword an argument such that another process stops
 * holding `index.lock`, so it spends repair budget rewording arguments that were never wrong, and
 * the person reading the turn is told the platform is broken when it is merely busy.
 *
 * The patterns below are all *contention*, never *rejection*:
 *
 * - `index.lock` — another commit is in flight in the same worktree. Ours is queued behind it and
 *   a moment later it is gone.
 * - `Unable to create ... .lock` / `File exists` — the same collision as git words it elsewhere.
 * - `could not lock config file` — concurrent config write during a commit's identity setup.
 * - `cannot lock ref` / `reference already exists` — two commits racing the same branch tip.
 *
 * Deliberately *not* matched: authentication failures, rejected pushes, protected-branch refusals
 * and merge conflicts. Each of those is a decision the remote made and will make again, so
 * retrying only reproduces it — the model and the person both need to see it.
 *
 * Push failures never reach here at all: `GitSyncService.withSync` logs and swallows them because
 * the commit is already durable (SOUL-V1-003), so a failed push is not a failed write.
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
 * The fault class a Soul commit failure should carry.
 *
 * Defaults to `internal_error` — the catch-all is *business* on purpose, because widening it would
 * make most failures retry twice for nothing. Only a recognized contention pattern is promoted.
 */
export function soulCommitFaultCode(error: unknown): ToolErrorCode {
  return isTransientGitFailure(error) ? "unavailable" : "internal_error";
}

/** `err()` for a Soul commit failure, carrying the right fault class. */
export function soulCommitError(error: unknown, message: string): ToolCallResult {
  return err(soulCommitFaultCode(error), message);
}
