import { type ActivityRecorderPort, recordJobRun } from "@tulipfarm/observability";
import type { Queryable } from "@tulipfarm/storage";
import type { PgBoss } from "pg-boss";
import type { KnowledgeService } from "./service";
import type { IndexQueueStats } from "./types";

export const KNOWLEDGE_INDEX_QUEUE = "knowledge-index";

const SAFE_TABLE = /^[A-Za-z0-9_."]+$/;

/**
 * Operational stats for the index queue, read from pg-boss (`getQueueStats` + the queue's job
 * table). Degrades to `{ pending: 0, lastError: null }` if the pg-boss schema isn't present or its
 * shape changes — index-status should never fail because the queue introspection did.
 */
export function makeIndexQueueStats(boss: PgBoss, db: Queryable): () => Promise<IndexQueueStats> {
  return async (): Promise<IndexQueueStats> => {
    let pending = 0;
    let lastError: IndexQueueStats["lastError"] = null;
    try {
      const stats = await boss.getQueueStats(KNOWLEDGE_INDEX_QUEUE);
      pending = stats.readyCount + stats.activeCount;
      if (stats.failedCount > 0 && stats.table && SAFE_TABLE.test(stats.table)) {
        const table = stats.table.includes(".") ? stats.table : `pgboss.${stats.table}`;
        const { rows } = await db.query(
          `SELECT output, completed_on FROM ${table}
           WHERE state = 'failed' ORDER BY completed_on DESC NULLS LAST LIMIT 1`
        );
        const row = rows[0] as { output: unknown; completed_on: Date } | undefined;
        if (row) {
          const message =
            row.output && typeof row.output === "object" && "message" in row.output
              ? String((row.output as { message: unknown }).message)
              : JSON.stringify(row.output ?? null);
          lastError = { message, failedAt: row.completed_on };
        }
      }
    } catch {}
    return { pending, lastError };
  };
}

export type IndexJob =
  | { kind: "page"; pageId: string }
  | { kind: "resource"; resourceType: string; resourceId: string; record: Record<string, unknown> }
  | { kind: "conversation"; conversationId: string };

export function jobKey(job: IndexJob): string {
  switch (job.kind) {
    case "page":
      return `page:${job.pageId}`;
    case "resource":
      return `resource:${job.resourceId}`;
    case "conversation":
      return `conversation:${job.conversationId}`;
  }
}

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
  loadConversationText?: (
    conversationId: string
  ) => Promise<{ title: string; content: string } | null>;
  activity?: ActivityRecorderPort;
}

/** The worker body — exported so it can be unit-tested without pg-boss. */
export async function handleIndexJob(job: IndexJob, deps: KnowledgeIndexingDeps): Promise<void> {
  switch (job.kind) {
    case "page":
      await deps.service.reindexById(job.pageId);
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

export async function registerKnowledgeIndexing(
  boss: PgBoss,
  deps: KnowledgeIndexingDeps
): Promise<void> {
  await boss.createQueue(KNOWLEDGE_INDEX_QUEUE);
  await boss.work(KNOWLEDGE_INDEX_QUEUE, (jobs: { data: IndexJob }[]) =>
    recordJobRun(
      deps.activity,
      KNOWLEDGE_INDEX_QUEUE,
      async () => {
        for (const job of jobs) {
          await handleIndexJob(job.data, deps);
        }
        return jobs.length;
      },
      (count) => ({ summary: `Indexed ${count} job(s)`, metadata: { jobs: count } })
    )
  );
}
