import { randomUUID } from "node:crypto";
import type { PaginatedResult } from "../pagination";
import type { ActivityListOpts, ActivityRepo, ActivityRow, ActivityStatus } from "./repo";

/** `actorId` present ⇒ user row; absent ⇒ system row. */
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

/** Activity writes are best-effort and must never break the triggering operation. */
export class ActivityService {
  constructor(private readonly repo: ActivityRepo) {}

  async record(input: RecordActivityInput): Promise<void> {
    try {
      const row: ActivityRow = {
        _id: randomUUID(),
        category: input.category,
        action: input.action,
        actorType: input.actorId ? "user" : "system",
        // `|| null` keeps an empty actorId out of the uuid column.
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
