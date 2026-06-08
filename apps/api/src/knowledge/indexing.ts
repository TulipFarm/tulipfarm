import type PgBoss from "pg-boss";
import type { KnowledgeService } from "./service";

export const KNOWLEDGE_INDEX_QUEUE = "knowledge-index";

/** What an indexing job carries — one variant per source adapter (KN-V1-003). */
export type IndexJob =
  | { kind: "document"; documentId: string }
  | { kind: "resource"; resourceType: string; resourceId: string; record: Record<string, unknown> }
  | { kind: "conversation"; conversationId: string };

/** Deterministic key so repeated events for the same source collapse to one job. */
export function jobKey(job: IndexJob): string {
  switch (job.kind) {
    case "document":
      return `document:${job.documentId}`;
    case "resource":
      return `resource:${job.resourceId}`;
    case "conversation":
      return `conversation:${job.conversationId}`;
  }
}

/** Minimal enqueue surface (a structural subset of pg-boss, fakeable in tests). */
export interface Enqueuer {
  send(
    name: string,
    data: object,
    options?: { singletonKey?: string; retryLimit?: number; retryBackoff?: boolean }
  ): Promise<string | null>;
}

export function enqueueIndex(boss: Enqueuer, job: IndexJob): Promise<string | null> {
  return boss.send(KNOWLEDGE_INDEX_QUEUE, job, {
    singletonKey: jobKey(job),
    retryLimit: 3,
    retryBackoff: true,
  });
}

const SYSTEM_FIELDS = new Set(["id", "version", "createdAt", "updatedAt", "deletedAt"]);

/** Flatten a resource record's human-readable string fields into indexable text. */
export function resourceToText(
  resourceType: string,
  record: Record<string, unknown>
): { title: string; content: string } {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (SYSTEM_FIELDS.has(key)) continue;
    if (typeof value === "string" && value.length > 0) parts.push(`${key}: ${value}`);
  }
  const title =
    typeof record.title === "string"
      ? record.title
      : typeof record.name === "string"
        ? record.name
        : `${resourceType} ${String(record.id ?? "")}`.trim();
  return { title, content: parts.join("\n") };
}

export interface KnowledgeIndexingDeps {
  service: KnowledgeService;
  /** Resolves a completed conversation into indexable text (injected to avoid a messageRepo dep here). */
  loadConversationText?: (
    conversationId: string
  ) => Promise<{ title: string; content: string } | null>;
}

/** The worker body — exported so it can be unit-tested without pg-boss. */
export async function handleIndexJob(job: IndexJob, deps: KnowledgeIndexingDeps): Promise<void> {
  switch (job.kind) {
    case "document":
      await deps.service.reindexById(job.documentId);
      return;
    case "resource": {
      const { title, content } = resourceToText(job.resourceType, job.record);
      if (content.trim().length === 0) return;
      await deps.service.ingestSource({
        source: "resource",
        sourceId: job.resourceId,
        title,
        content,
      });
      return;
    }
    case "conversation": {
      const text = await deps.loadConversationText?.(job.conversationId);
      if (!text || text.content.trim().length === 0) return;
      await deps.service.ingestSource({
        source: "conversation",
        sourceId: job.conversationId,
        title: text.title,
        content: text.content,
      });
      return;
    }
  }
}

/** Register the in-process `knowledge-index` queue + worker (MODE=all). */
export async function registerKnowledgeIndexing(
  boss: PgBoss,
  deps: KnowledgeIndexingDeps
): Promise<void> {
  await boss.createQueue(KNOWLEDGE_INDEX_QUEUE);
  await boss.work(KNOWLEDGE_INDEX_QUEUE, async (jobs: { data: IndexJob }[]) => {
    for (const job of jobs) {
      await handleIndexJob(job.data, deps);
    }
  });
}
