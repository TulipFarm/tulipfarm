import { randomUUID } from "node:crypto";
import { MAX_ENTRIES, MAX_TOTAL_CHARS, MAX_VALUE_CHARS } from "./limits";
import type { WorkingMemoryDoc, WorkingMemoryRepo } from "./working-memory";

export type UpdateOutcome = { kind: "ok" } | { kind: "rejected_oversize" };

/**
 * Owns the working-memory write policy (MEM-V1-003): oversize rejection, last-write LRU, and the
 * dual cap (≤ MAX_ENTRIES and ≤ MAX_TOTAL_CHARS). The repo stays a dumb CRUD store; all the
 * "should this be kept?" judgement lives here so it is testable against an in-memory fake.
 */
export class WorkingMemoryService {
  constructor(private readonly repo: WorkingMemoryRepo) {}

  async update(
    userId: string,
    key: string,
    value: string,
    writtenByAgentId?: string
  ): Promise<UpdateOutcome> {
    if (value.length > MAX_VALUE_CHARS) {
      return { kind: "rejected_oversize" }; // AC-V1-004: document-sized → caller redirects to knowledge
    }

    const existing = (await this.repo.listByUser(userId)).find((e) => e.key === key);
    const now = new Date();
    await this.repo.upsert({
      _id: existing?._id ?? randomUUID(),
      userId,
      key,
      value,
      writtenByAgentId,
      createdAt: existing?.createdAt ?? now,
      lastWrittenAt: now, // last-write recency (AC-V1-004 #1)
    });

    await this.evict(userId, key);
    return { kind: "ok" };
  }

  delete(userId: string, key: string): Promise<boolean> {
    return this.repo.deleteByKey(userId, key); // idempotent: false if the key was already absent
  }

  /** A user's entries, oldest-written first — the order the `<memory>` block renders. */
  list(userId: string): Promise<WorkingMemoryDoc[]> {
    return this.repo.listByUser(userId);
  }

  /** Drop oldest-written entries until BOTH caps hold; never evict the just-written key. */
  private async evict(userId: string, keepKey: string): Promise<void> {
    let entries = await this.repo.listByUser(userId); // oldest-first
    const totalChars = (es: WorkingMemoryDoc[]): number =>
      es.reduce((sum, e) => sum + e.key.length + e.value.length, 0);

    while (entries.length > MAX_ENTRIES || totalChars(entries) > MAX_TOTAL_CHARS) {
      const victim = entries.find((e) => e.key !== keepKey);
      if (!victim) break; // only the just-written entry remains — cannot shrink further
      await this.repo.deleteByKey(userId, victim.key);
      entries = entries.filter((e) => e._id !== victim._id);
    }
  }
}
