import { randomUUID } from "node:crypto";
import type { PaginatedResult } from "../pagination";
import type { ActivityListOpts, ActivityRepo, ActivityRow, ActivityStatus } from "./repo";

/**
 * Input to `ActivityService.record`. `actorId` present ⇒ the row is attributed to that user;
 * absent ⇒ a 'system' row (jobs, soul-sync, untracked writers). Everything but category/action/
 * summary is optional.
 */
export interface RecordActivityInput {
  category: string;
  action: string;
  actorId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  summary: string;
  status?: ActivityStatus;
  metadata?: Record<string, unknown>;
}

/**
 * The single write path for the workspace activity feed. `record` is **best-effort**: it builds the
 * row (id + createdAt) and inserts it, but never throws into the caller — a failed audit write must
 * not break the primary operation that triggered it. `list` is a thin passthrough to the repo's
 * keyset page.
 */
export class ActivityService {
  constructor(private readonly repo: ActivityRepo) {}

  async record(input: RecordActivityInput): Promise<void> {
    try {
      const row: ActivityRow = {
        _id: randomUUID(),
        category: input.category,
        action: input.action,
        actorType: input.actorId ? "user" : "system",
        // `|| null` (not `?? null`) so an empty-string actorId maps to a system row instead of
        // hitting the uuid column with invalid syntax — consistent with the actorType guard above.
        actorId: input.actorId || null,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        summary: input.summary,
        status: input.status ?? "ok",
        metadata: input.metadata ?? {},
        createdAt: new Date(),
      };
      await this.repo.insert(row);
    } catch (err) {
      console.error(
        `[activity] record failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async list(opts: ActivityListOpts): Promise<PaginatedResult<ActivityRow>> {
    return this.repo.list(opts);
  }
}
