import { setTimeout } from "node:timers/promises";
import {
  MCP_KNOWLEDGE_POLL_INTERVAL_MS,
  type McpKnowledgeCheckpoint,
  type McpKnowledgeSelection,
  type McpKnowledgeSyncDeps,
  syncMcpKnowledgeBatch,
} from "@tulipfarm/knowledge/mcp";
import type { DrainableLoop } from "../shutdown";

export interface McpKnowledgeJob {
  readonly leaseId: string;
  readonly selection: McpKnowledgeSelection;
}

/** Finish fences lease/selection revisions and preserves newer manual/notification requests. */
export interface McpKnowledgeJobPort {
  claimDue(input: {
    readonly now: Date;
    readonly limit: number;
  }): Promise<readonly McpKnowledgeJob[]>;
  finish(
    job: McpKnowledgeJob,
    result:
      | { readonly status: "progress"; readonly checkpoint: McpKnowledgeCheckpoint }
      | { readonly status: "failed"; readonly code: "sync_failed" },
    nextAttemptAt: Date
  ): Promise<void>;
  requestSync(input: {
    readonly businessId: string;
    readonly accountId: string;
    readonly selectionId: string;
    readonly reason: "manual" | "notification";
  }): Promise<void>;
}

export interface McpKnowledgeWorkerDeps {
  readonly jobs: McpKnowledgeJobPort;
  readonly open: (job: McpKnowledgeJob) => Promise<McpKnowledgeSyncDeps>;
  readonly now: () => Date;
  readonly log: { warn(message: string): void };
  readonly wait?: (signal: AbortSignal) => Promise<void>;
}

export async function runMcpKnowledgeCycle(
  deps: McpKnowledgeWorkerDeps,
  signal: AbortSignal
): Promise<void> {
  const jobs = await deps.jobs.claimDue({ now: deps.now(), limit: 1 });
  if (jobs.length > 1) throw new Error("mcp_knowledge_claim_limit_exceeded");
  for (const job of jobs) {
    if (signal.aborted) break;
    try {
      const syncDeps = await deps.open(job);
      const checkpoint = await syncMcpKnowledgeBatch(job.selection, syncDeps, { signal });
      const delay = checkpoint.complete
        ? (job.selection.pollIntervalMs ?? MCP_KNOWLEDGE_POLL_INTERVAL_MS)
        : 1000;
      await deps.jobs.finish(
        job,
        { status: "progress", checkpoint },
        new Date(deps.now().getTime() + delay)
      );
      if (checkpoint.failed > 0) deps.log.warn("MCP Knowledge sync has failed source reads");
    } catch {
      // Provider errors can contain private source names and credentials. Persist only safe codes.
      deps.log.warn("MCP Knowledge sync batch failed");
      await deps.jobs.finish(
        job,
        { status: "failed", code: "sync_failed" },
        new Date(deps.now().getTime() + MCP_KNOWLEDGE_POLL_INTERVAL_MS)
      );
    }
  }
}

async function wait(signal: AbortSignal): Promise<void> {
  try {
    await setTimeout(1000, undefined, { signal });
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}

export function startMcpKnowledgeSyncLoop(
  signal: AbortSignal,
  deps: McpKnowledgeWorkerDeps
): DrainableLoop {
  const settled = (async () => {
    while (!signal.aborted) {
      try {
        await runMcpKnowledgeCycle(deps, signal);
      } catch {
        deps.log.warn("MCP Knowledge sync scheduling failed");
      }
      await (deps.wait ?? wait)(signal);
    }
  })();
  return { name: "mcp-knowledge-sync", settled };
}
