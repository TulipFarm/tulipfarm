import { randomUUID } from "node:crypto";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { MemoryAssertion, MemoryDeps, MemoryTelemetryPort } from "@tulipfarm/memory";
import { recallMemory } from "@tulipfarm/memory";
import type { Queryable } from "../db";
import { PgMemoryAssertionStore } from "./assertion-store";
import type { MemoryEmbedder } from "./embedder";
import { EPISODE_MEMORY_SETTINGS } from "./episode-store";
import { PgPendingMemoryStore } from "./pending-store";
import { PgMemoryRecallIndex } from "./recall-index";

/**
 * Relevance recall over durable Memory, for the `recall_memory` tool and the retrieved prompt tier.
 *
 * Thin by design: it owns wiring, not policy. Authorization, exclusion accounting, and ranking all
 * live in `@tulipfarm/memory`, so there is exactly one place where "may this caller see this
 * assertion" is decided.
 */
export class MemoryRecallService {
  private readonly deps: MemoryDeps;

  constructor(q: Queryable, embedder?: MemoryEmbedder, telemetry?: MemoryTelemetryPort) {
    this.deps = {
      store: new PgMemoryAssertionStore(q),
      pending: new PgPendingMemoryStore(q),
      index: new PgMemoryRecallIndex(q, embedder, telemetry),
      settings: EPISODE_MEMORY_SETTINGS,
      ...(telemetry === undefined ? {} : { telemetry }),
      now: () => new Date(),
      newId: () => randomUUID(),
    };
  }

  /** The assertions this user may see for `query`, most relevant first. */
  async recall(
    userId: string,
    query: string,
    limit: number,
    agentId?: string
  ): Promise<readonly MemoryAssertion[]> {
    const result = await recallMemory(this.deps, {
      businessId: DEPLOYMENT_BUSINESS_ID,
      principalId: userId,
      query,
      limit,
      ...(agentId === undefined ? {} : { agentId }),
    });
    return result.assertions;
  }
}
