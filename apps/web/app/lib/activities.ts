import { apiGet } from "./api";

/*
 * Read-only client for the workspace activity feed (GET /api/v1/activities). Newest-first,
 * cursor-paginated, optional category filter. Mirrors the other typed wrappers in lib/.
 */

export type ActivityItem = {
  id: string;
  category: string;
  action: string;
  actorType: "user" | "system";
  actorId: string | null;
  targetType: string | null;
  targetId: string | null;
  summary: string;
  status: "ok" | "error";
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type ActivityPage = {
  items: ActivityItem[];
  nextCursor: string | null;
};

export async function listActivities(
  opts: { cursor?: string; category?: string; limit?: number } = {}
): Promise<ActivityPage> {
  const query = new URLSearchParams({ limit: String(opts.limit ?? 50) });
  if (opts.cursor) query.set("cursor", opts.cursor);
  if (opts.category) query.set("category", opts.category);
  return apiGet<ActivityPage>(`/api/v1/activities?${query.toString()}`);
}
