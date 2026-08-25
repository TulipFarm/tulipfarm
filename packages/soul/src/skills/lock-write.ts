import type { SoulWriteRequest, SoulWriteResult, SoulWriter } from "../writer";
import { SoulWriteError } from "../writer";
import { parseSkillsLock, type SkillsLock } from "./lock";

/** What a caller supplies; {@link mutateSkillsLock} owns the base revision. */
export type SkillsLockWriteRequest = Omit<SoulWriteRequest, "expectedBaseCommit">;

/** Enough of {@link SoulWriter} to read the lock and commit it, so tests can supply a double. */
export interface SkillsLockWriter {
  readWithBase(kind: "SkillsLock"): Promise<{ content: string | null; baseCommit: string }>;
  apply(request: SoulWriteRequest): Promise<SoulWriteResult>;
}

const MAX_ATTEMPTS = 3;

/**
 * `skills-lock.json` is a whole-file read-modify-write, so two writers that read the same revision
 * would each commit a lock that never saw the other's entry — the later commit silently erasing the
 * earlier Skill's provenance while its directory stays on disk. Serializing in-process is not
 * enough on its own: the Worker and an operator's own `git` both commit to the same Soul.
 *
 * So this does both. Writers queue behind each other per Soul, and each commit carries the revision
 * its read observed, which the changeset gateway rejects if anything landed in between. A rejection
 * is not retried with the same bytes — `build` runs again against the newly current lock, because a
 * stale lock recomputed is the whole point.
 *
 * `build` receives the parsed lock and the exact bytes it came from, so a caller can tell a lock
 * that merely needs re-serializing from one that is already canonical. It returns `null` to abort
 * without committing, for the common "nothing actually changed" case; the result is then `null`.
 */
export async function mutateSkillsLock(
  writer: SkillsLockWriter,
  soulPath: string,
  build: (
    lock: SkillsLock,
    raw: string | null
  ) => Promise<SkillsLockWriteRequest | null> | SkillsLockWriteRequest | null
): Promise<SoulWriteResult | null> {
  return serializeSkillsLockWrites(soulPath, async () => {
    for (let attempt = 1; ; attempt++) {
      const { content, baseCommit } = await writer.readWithBase("SkillsLock");
      const request = await build(parseSkillsLock(content), content);
      if (request === null) return null;
      try {
        return await writer.apply({ ...request, expectedBaseCommit: baseCommit });
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS || !isConflict(error)) throw error;
      }
    }
  });
}

function isConflict(error: unknown): boolean {
  return error instanceof SoulWriteError && error.code === "CONFLICT";
}

const queues = new Map<string, Promise<unknown>>();

/**
 * Run `task` after every lock write already queued for this Soul. The queue is keyed by Soul path
 * rather than kept in one global, so a test Soul cannot serialize behind an unrelated one.
 */
export async function serializeSkillsLockWrites<T>(
  soulPath: string,
  task: () => Promise<T>
): Promise<T> {
  const previous = queues.get(soulPath) ?? Promise.resolve();
  // Settled, not resolved: one writer's failure must not cancel the writers queued behind it.
  const next = previous.then(task, task);
  const guarded = next.catch(() => undefined);
  queues.set(soulPath, guarded);
  try {
    return await next;
  } finally {
    // Drop the queue once it drains, so a long-lived process does not retain an entry per Soul.
    if (queues.get(soulPath) === guarded) queues.delete(soulPath);
  }
}
