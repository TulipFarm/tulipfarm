import { hashKey, type QueryKey } from '@tanstack/react-query';
import { requestSignal } from '../http';
import type { SessionIdentity, WorkspaceScope } from './scope';

/**
 * Reads a route starts while workspace admission is still running, so a page's first
 * query can reuse the response instead of waiting for the frame to mount.
 *
 * An entry is only handed to a query for the same session, workspace and admitted
 * membership, once, and only a successful response. Anything else falls back to the
 * query's own request, so denial handling stays with the query.
 */
export type EarlyRead = { key: QueryKey; load: (signal: AbortSignal) => Promise<unknown> };
type Outcome = { value: unknown } | null;
type Entry = {
  identity: SessionIdentity;
  workspaceId: string;
  key: QueryKey;
  membershipId: string | null;
  outcome: Promise<Outcome>;
  settledAt: number | null;
  controller: AbortController;
};

// Long enough for the page to mount after admission, short enough that a response is never
// treated as fresher than the query's own freshness window.
const maxAge = 10_000;
const entries = new Map<string, Entry>();

const entryHash = (userId: string, workspaceId: string, key: QueryKey) => hashKey([userId, workspaceId, ...key]);

function remove(hash: string, entry: Entry) {
  if (entries.get(hash) !== entry) return;
  entries.delete(hash);
  if (entry.settledAt === null) entry.controller.abort();
}

export function startEarlyReads(identity: SessionIdentity, workspaceId: string, reads: readonly EarlyRead[]) {
  for (const [hash, entry] of entries)
    if (entry.settledAt !== null && Date.now() - entry.settledAt > maxAge) remove(hash, entry);
  const started: [string, Entry][] = [];
  for (const read of reads) {
    const hash = entryHash(identity.userId, workspaceId, read.key);
    const existing = entries.get(hash);
    if (existing) remove(hash, existing);
    const controller = new AbortController();
    const entry: Entry = {
      identity,
      workspaceId,
      key: read.key,
      membershipId: null,
      settledAt: null,
      controller,
      outcome: read.load(requestSignal(controller.signal)).then(
        value => ({ value }),
        () => null,
      ),
    };
    void entry.outcome.then(() => {
      entry.settledAt = Date.now();
    });
    entries.set(hash, entry);
    started.push([hash, entry]);
  }
  return {
    /** Only reads bound to the admitted membership can be used. */
    admit(membershipId: string) {
      for (const [, entry] of started) entry.membershipId = membershipId;
    },
    discard() {
      for (const [hash, entry] of started) remove(hash, entry);
    },
  };
}

/** Resolves to the early response, or null when the query must read for itself. */
export function takeEarlyRead<T>(
  identity: SessionIdentity,
  scope: WorkspaceScope,
  key: QueryKey,
  signal: AbortSignal,
): Promise<{ value: T } | null> | null {
  const hash = entryHash(scope.userId, scope.workspaceId, key);
  const entry = entries.get(hash);
  if (!entry) return null;
  // Handed over, not removed: a pending read keeps running for the query that took it.
  entries.delete(hash);
  if (
    entry.identity.userId !== identity.userId ||
    entry.identity.sessionId !== identity.sessionId ||
    entry.membershipId !== scope.membershipId ||
    (entry.settledAt !== null && Date.now() - entry.settledAt > maxAge)
  ) {
    entry.controller.abort();
    return null;
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      if (entry.settledAt === null) entry.controller.abort();
      reject(signal.reason);
    };
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    void entry.outcome.then(outcome => {
      signal.removeEventListener('abort', abort);
      resolve(outcome as { value: T } | null);
    });
  });
}

const startsWith = (key: QueryKey, prefix: QueryKey) =>
  prefix.length <= key.length && hashKey(key.slice(0, prefix.length)) === hashKey(prefix);

/** Drops early reads a change, revocation or sign-out makes unsafe to reuse. */
export function discardEarlyReads(userId: string, workspaceId?: string, keys?: readonly QueryKey[]) {
  for (const [hash, entry] of entries) {
    if (entry.identity.userId !== userId) continue;
    if (workspaceId !== undefined && entry.workspaceId !== workspaceId) continue;
    if (keys && !keys.some(prefix => startsWith(entry.key, prefix))) continue;
    remove(hash, entry);
  }
}
