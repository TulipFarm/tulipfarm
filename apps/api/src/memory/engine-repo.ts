import { randomUUID } from "node:crypto";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import {
  forgetMemory,
  type MemoryAssertion,
  type MemoryDeps,
  type MemoryScopeRequest,
  type MemorySettingsView,
  type MemoryTelemetryPort,
  rememberMemory,
} from "@tulipfarm/memory";
import type { Queryable } from "../db";
import { PgMemoryAssertionStore } from "./assertion-store";
import { assertValidAssertion, type MemoryAssertionView, type MemoryRepo } from "./assertion-view";
import type { MemoryEmbedder } from "./embedder";
import { PgPendingMemoryStore } from "./pending-store";

/**
 * `MemoryRepo` backed by the `@tulipfarm/memory` engine.
 *
 * This is the M1 seam. The KV surface above it — `MemoryService`, `update_memory`,
 * `/api/v1/memory`, Settings → Memory — is unchanged; underneath, every entry is now a scoped,
 * versioned `user_private` Assertion, so edits supersede rather than overwrite and deletes leave
 * an auditable tombstone. Nothing user-visible changes; the history does.
 *
 * Three mappings carry the old contract onto the new model:
 *
 * - `key` → `subject`, `value` → `statement`. The engine's per-subject uniqueness is what made
 *   the old `(user_id, key)` primary key redundant.
 * - `createdAt` → `validFrom`. The KV row preserved its creation time across edits; a superseding
 *   Assertion gets a fresh `createdAt`, so the original is carried forward as valid-time — which
 *   is also what it actually means: when the preference started being true.
 * - `lastWrittenAt` → `updatedAt`, and listing orders by it. The old repo ordered by
 *   `last_written_at`, and `MemoryService`'s LRU eviction consumes that order, so
 *   reproducing it exactly is what keeps eviction behaviour identical.
 */

/**
 * Deployment-default Memory settings for the KV surface.
 *
 * `user_private` is the only scope this surface has ever written, and inferred memory stays off
 * until M3 ships the extraction pipeline and its confirmation gate — with it off, `rememberMemory`
 * refuses inferred writes outright, so no unconfirmed statement can reach the store through here
 * even by mistake. Per-Agent settings replace this in M3.
 */
export const KV_MEMORY_SETTINGS: MemorySettingsView = {
  scopes: ["user_private"],
  inferredDurableMemory: { enabled: false },
};

function docFromAssertion(assertion: MemoryAssertion): MemoryAssertionView {
  const doc: MemoryAssertionView = {
    _id: assertion.assertionId,
    userId: assertion.target.subjectPrincipalId ?? "",
    key: assertion.subject,
    value: assertion.statement,
    createdAt: new Date(assertion.validFrom),
    lastWrittenAt: new Date(assertion.updatedAt),
  };
  if (assertion.provenance.authorAgentId !== undefined) {
    doc.writtenByAgentId = assertion.provenance.authorAgentId;
  }
  return doc;
}

export class EngineMemoryRepo implements MemoryRepo {
  private readonly store: PgMemoryAssertionStore;
  private readonly pending: PgPendingMemoryStore;

  constructor(
    q: Queryable,
    private readonly now: () => Date = () => new Date(),
    embedder?: MemoryEmbedder,
    private readonly telemetry?: MemoryTelemetryPort
  ) {
    this.store = new PgMemoryAssertionStore(q, embedder);
    this.pending = new PgPendingMemoryStore(q);
  }

  /**
   * The engine stamps `updatedAt` from its clock, and `lastWrittenAt` is supplied by the caller
   * (`MemoryService` passes the write time, and its LRU eviction reads that ordering back).
   * Binding the clock per operation is what keeps the two the same value.
   */
  private depsAt(at: Date): MemoryDeps {
    return {
      store: this.store,
      pending: this.pending,
      settings: KV_MEMORY_SETTINGS,
      ...(this.telemetry === undefined ? {} : { telemetry: this.telemetry }),
      now: () => at,
      newId: () => randomUUID(),
    };
  }

  async upsert(doc: MemoryAssertionView): Promise<void> {
    assertValidAssertion(doc);
    const prior = await this.findActive(doc.userId, doc.key);
    const result = await rememberMemory(
      this.depsAt(doc.lastWrittenAt),
      {
        target: {
          scope: "user_private",
          businessId: DEPLOYMENT_BUSINESS_ID,
          subjectPrincipalId: doc.userId,
        },
        subject: doc.key,
        statement: doc.value,
        // The KV surface carries no confidence signal, and everything written through it is
        // either user-authored or an agent acting on something the user said, so it is certain
        // by construction rather than estimated.
        confidence: 1,
        memoryType: "preference",
        trustTier: "user_stated",
        provenance: {
          origin: "explicit",
          authorPrincipalId: doc.userId,
          ...(doc.writtenByAgentId === undefined ? {} : { authorAgentId: doc.writtenByAgentId }),
          evidence: [],
        },
        // Carry the original creation forward so an edit does not look newly true.
        validFrom: prior?.validFrom ?? doc.createdAt.toISOString(),
        ...(prior === undefined ? {} : { supersedesId: prior.assertionId }),
      },
      this.scopeRequest(doc.userId)
    );

    if (result.outcome !== "saved") {
      // Unreachable through this surface: the scope is enabled, the target is complete, and the
      // origin is explicit. Failing loudly beats silently dropping a write the user watched
      // succeed.
      throw new Error(
        `memory write failed: ${result.outcome}${
          result.outcome === "denied" ? ` (${result.reason})` : ""
        }`
      );
    }
  }

  async deleteByKey(userId: string, key: string): Promise<boolean> {
    const existing = await this.findActive(userId, key);
    if (existing === undefined) return false; // idempotent, as before
    const result = await forgetMemory(
      this.depsAt(this.now()),
      { businessId: DEPLOYMENT_BUSINESS_ID, assertionId: existing.assertionId },
      this.scopeRequest(userId)
    );
    return result.outcome === "forgotten";
  }

  /** A user's entries, oldest-written first (the order LRU eviction consumes). */
  async listByUser(userId: string): Promise<MemoryAssertionView[]> {
    const active = await this.activeFor(userId);
    return active
      .map(docFromAssertion)
      .sort((a, b) => a.lastWrittenAt.getTime() - b.lastWrittenAt.getTime());
  }

  private async activeFor(userId: string): Promise<readonly MemoryAssertion[]> {
    const active = await this.store.listActiveForScope(DEPLOYMENT_BUSINESS_ID, {
      scope: "user_private",
      subjectPrincipalId: userId,
    });
    // Pending candidates never reach the store, but confirmation state is the engine's gate on
    // what counts as memory — read it rather than assume it.
    return active.filter((a) => a.confirmation === "confirmed");
  }

  private async findActive(userId: string, key: string): Promise<MemoryAssertion | undefined> {
    const active = await this.activeFor(userId);
    return active.find((a) => a.subject === key);
  }

  private scopeRequest(userId: string): MemoryScopeRequest {
    return { businessId: DEPLOYMENT_BUSINESS_ID, principalId: userId };
  }
}
