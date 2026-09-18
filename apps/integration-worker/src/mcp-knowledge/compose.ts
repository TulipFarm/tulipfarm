import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { MCP_KNOWLEDGE_POLL_INTERVAL_MS } from "@tulipfarm/knowledge/mcp";
import { validateMcpKnowledgeCheckpointDocument } from "@tulipfarm/schema";
import {
  McpKnowledgeFenceError,
  McpKnowledgeStore,
  type Queryable,
  type TransactionPort,
} from "@tulipfarm/storage";
import { InternalApiClient } from "../internal/client";
import type { DrainableLoop } from "../shutdown";

/** API hosts scoped credentials/publication; only this worker schedules durable sync claims. */
export function composeMcpKnowledgeSyncLoop(
  signal: AbortSignal,
  input: {
    readonly baseUrl: string;
    readonly credential: string;
    readonly db: Queryable;
    readonly transactions: TransactionPort;
    readonly businessId: string;
    readonly log: { warn(message: string): void };
    readonly fetch?: typeof globalThis.fetch;
    readonly onCycle?: () => void;
  }
): DrainableLoop {
  const store = new McpKnowledgeStore(input.db, input.transactions);
  const client = new InternalApiClient({
    baseUrl: input.baseUrl,
    credential: input.credential,
    timeoutMs: 115_000,
    fetch: (url, init) =>
      (input.fetch ?? globalThis.fetch)(url, {
        ...init,
        signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
      }),
  });
  const settled = (async () => {
    while (!signal.aborted) {
      try {
        await client.require("POST", "/api/v1/internal/mcp-knowledge/reconcile", {});
        const claim = await store.claimDue(input.businessId, randomUUID(), new Date());
        if (claim) {
          try {
            const checkpoint = validateMcpKnowledgeCheckpointDocument(
              await client.require("POST", "/api/v1/internal/mcp-knowledge/batch", {
                accountId: claim.selection.binding.accountId,
                selectionId: claim.selection.id,
                selectionRevision: claim.selection.revision,
                leaseId: claim.leaseId,
              })
            );
            if (checkpoint.selectionRevision !== claim.selection.revision)
              throw new McpKnowledgeFenceError();
            const now = new Date();
            await store.finish(
              claim,
              now,
              new Date(
                now.getTime() +
                  (checkpoint.complete
                    ? (claim.selection.pollIntervalMs ?? MCP_KNOWLEDGE_POLL_INTERVAL_MS)
                    : 1000)
              ),
              checkpoint.failed ? "source_unavailable" : null,
              checkpoint.complete
            );
          } catch (error) {
            if (!(error instanceof McpKnowledgeFenceError)) {
              const now = new Date();
              await store
                .finish(
                  claim,
                  now,
                  new Date(now.getTime() + MCP_KNOWLEDGE_POLL_INTERVAL_MS),
                  "sync_failed",
                  false
                )
                .catch((failure: unknown) => {
                  if (!(failure instanceof McpKnowledgeFenceError)) throw failure;
                });
            }
            input.log.warn("MCP Knowledge sync batch will retry");
          }
        }
        input.onCycle?.();
      } catch {
        input.log.warn("MCP Knowledge sync cycle will retry");
      }
      try {
        await setTimeout(1000, undefined, { signal });
      } catch {
        if (!signal.aborted) throw new Error("mcp_knowledge_poll_interrupted");
      }
    }
  })();
  return { name: "mcp-knowledge-sync", settled };
}
