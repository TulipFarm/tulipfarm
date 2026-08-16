/** Scoped Memory assertions are versioned; inferred saves become Pending Memory. */

import type { AuditEventInput } from "@tulipfarm/audit";
import type { MemoryScope } from "@tulipfarm/schema";
import type { PendingMemoryStore } from "./confirm";
import type { MemoryContradictionPort } from "./contradiction";
import type { MemoryRecallIndex } from "./retrieve";
import type { MemoryScopeRequest, MemoryScopeTarget } from "./scope";
import type { MemoryTelemetryPort } from "./telemetry";

export type MemoryOrigin = "explicit" | "inferred";
export type MemoryConfirmationState = "confirmed" | "pending" | "denied" | "expired";
export type MemoryStatus = "active" | "superseded" | "forgotten";

/** What kind of thing an assertion says, which decides how it is recalled and rendered. */
export const MEMORY_TYPES = ["preference", "fact", "procedural", "episodic"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** Origin trust follows source, not saver; external Knowledge stays `external_derived`. */
export const MEMORY_TRUST_TIERS = ["user_stated", "agent_inferred", "external_derived"] as const;
export type MemoryTrustTier = (typeof MEMORY_TRUST_TIERS)[number];

/** What an assertion is based on. Knowledge-backed evidence is reauthorized on every recall. */
export interface MemoryEvidenceRef {
  readonly kind: "message" | "knowledge_source" | "tool_result";
  readonly ref: string;
  readonly sourceId?: string;
  readonly revision?: string;
}

export interface MemoryProvenance {
  readonly origin: MemoryOrigin;
  readonly authorPrincipalId: string;
  /** The Agent that authored the statement, when one did. Not the same as an Agent-scoped owner. */
  readonly authorAgentId?: string;
  readonly runId?: string;
  readonly evidence: readonly MemoryEvidenceRef[];
}

export interface MemoryAssertion {
  readonly assertionId: string;
  readonly businessId: string;
  readonly target: MemoryScopeTarget;
  readonly subject: string;
  readonly statement: string;
  readonly memoryType: MemoryType;
  readonly trustTier: MemoryTrustTier;
  /** 0–1. Explicit statements are 1; inferred ones carry the Agent's own confidence. */
  readonly confidence: number;
  /** 0–1. How much this assertion is worth recalling, independent of how certain it is. */
  readonly importance: number;
  readonly provenance: MemoryProvenance;
  readonly confirmation: MemoryConfirmationState;
  readonly status: MemoryStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Transaction-time close; separate from valid time so belief history and world truth differ. */
  readonly recordedUntil?: string;
  /** Valid time: when the statement started being true in the world. Defaults to `createdAt`. */
  readonly validFrom: string;
  /** Valid time, closing half. Absent means the statement is still true. */
  readonly validTo?: string;
  readonly expiresAt?: string;
  readonly supersedesId?: string;
  readonly supersededById?: string;
  /** Normalized entity names this assertion is about, for entity-matched recall. */
  readonly entities: readonly string[];
  /** Recall counters, used to weight ranking. Never a reason to include or exclude on their own. */
  readonly accessCount: number;
  readonly lastAccessedAt?: string;
}

/** Lookup filter only; `authorizeMemoryScope` still authorizes returned rows. */
export interface MemoryScopeFilter {
  readonly scope: MemoryScope;
  readonly subjectPrincipalId?: string;
  readonly agentId?: string;
  readonly roleId?: string;
  readonly runId?: string;
}

export interface MemoryStore {
  put(assertion: MemoryAssertion): Promise<void>;
  get(businessId: string, assertionId: string): Promise<MemoryAssertion | undefined>;
  /** Every assertion in the business, whatever its status — recall does its own filtering. */
  list(businessId: string): Promise<readonly MemoryAssertion[]>;
  listActive(businessId: string): Promise<readonly MemoryAssertion[]>;
  /** Active assertions for one owner, oldest-created first; callers must name the owner. */
  listActiveForScope(
    businessId: string,
    filter: MemoryScopeFilter
  ): Promise<readonly MemoryAssertion[]>;
  /** Fetch ranked assertion ids without loading a whole business. */
  getMany(businessId: string, assertionIds: readonly string[]): Promise<readonly MemoryAssertion[]>;
  erase(assertion: MemoryAssertion): Promise<MemoryEraseStoreCounts>;
}

export interface MemoryEraseStoreCounts {
  readonly assertions: number;
  readonly evidenceRefs: number;
  readonly recallIndexRows: number;
  readonly episodes: number;
  readonly chunks: number;
}

export interface MemoryEraseCounts extends MemoryEraseStoreCounts {
  readonly pending: number;
}

/** True when `assertion` is owned by exactly the scope `filter` names. */
export function matchesScopeFilter(assertion: MemoryAssertion, filter: MemoryScopeFilter): boolean {
  const t = assertion.target;
  return (
    t.scope === filter.scope &&
    t.subjectPrincipalId === filter.subjectPrincipalId &&
    t.agentId === filter.agentId &&
    t.roleId === filter.roleId &&
    t.runId === filter.runId
  );
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly byId = new Map<string, MemoryAssertion>();

  private key(businessId: string, assertionId: string): string {
    return `${businessId}:${assertionId}`;
  }

  async put(assertion: MemoryAssertion): Promise<void> {
    this.byId.set(this.key(assertion.businessId, assertion.assertionId), assertion);
  }

  async get(businessId: string, assertionId: string): Promise<MemoryAssertion | undefined> {
    return this.byId.get(this.key(businessId, assertionId));
  }

  async list(businessId: string): Promise<readonly MemoryAssertion[]> {
    return [...this.byId.values()].filter((a) => a.businessId === businessId);
  }

  async listActive(businessId: string): Promise<readonly MemoryAssertion[]> {
    return (await this.list(businessId)).filter((a) => a.status === "active");
  }

  async listActiveForScope(
    businessId: string,
    filter: MemoryScopeFilter
  ): Promise<readonly MemoryAssertion[]> {
    return (await this.listActive(businessId))
      .filter((a) => matchesScopeFilter(a, filter))
      .sort((a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? -1 : 1));
  }

  async getMany(
    businessId: string,
    assertionIds: readonly string[]
  ): Promise<readonly MemoryAssertion[]> {
    const found: MemoryAssertion[] = [];
    for (const assertionId of assertionIds) {
      const assertion = this.byId.get(this.key(businessId, assertionId));
      if (assertion !== undefined) found.push(assertion);
    }
    return found;
  }

  async erase(assertion: MemoryAssertion): Promise<MemoryEraseStoreCounts> {
    const deleted = this.byId.delete(this.key(assertion.businessId, assertion.assertionId));
    if (deleted) {
      for (const candidate of [...this.byId.values()]) {
        if (candidate.businessId !== assertion.businessId) continue;
        if (
          candidate.supersedesId !== assertion.assertionId &&
          candidate.supersededById !== assertion.assertionId
        ) {
          continue;
        }
        const { supersedesId, supersededById, ...rest } = candidate;
        const updated: MemoryAssertion = {
          ...rest,
          ...(supersedesId === assertion.assertionId || supersedesId === undefined
            ? {}
            : { supersedesId }),
          ...(supersededById === assertion.assertionId || supersededById === undefined
            ? {}
            : { supersededById }),
        };
        this.byId.set(this.key(candidate.businessId, candidate.assertionId), updated);
      }
    }
    return {
      assertions: deleted ? 1 : 0,
      evidenceRefs: assertion.provenance.evidence.length,
      recallIndexRows: deleted ? 1 : 0,
      episodes: 0,
      chunks: 0,
    };
  }
}

export interface MemoryAuditSink {
  record(event: AuditEventInput): Promise<void>;
}

/** The parts of MemorySettings this package enforces, decoupled from the Soul definition shape. */
export interface MemorySettingsView {
  readonly scopes: readonly MemoryScope[];
  readonly inferredDurableMemory:
    | { readonly enabled: true; readonly confirmationRequired: true }
    | { readonly enabled: false };
  readonly defaultExpiryDays?: number;
}

/** Knowledge-backed evidence is reauthorized through an app port; `undefined` denies. */
export interface MemoryEvidenceAuthorizationPort {
  authorize(input: {
    readonly businessId: string;
    readonly principalId: string;
    readonly sourceId: string;
    readonly revision?: string;
  }): Promise<boolean | undefined>;
}

export interface MemoryDeps {
  readonly store: MemoryStore;
  readonly pending: PendingMemoryStore;
  readonly evidence?: MemoryEvidenceAuthorizationPort;
  /** Optional relevance retrieval; without it recall falls back to recency. */
  readonly index?: MemoryRecallIndex;
  /** Optional contradiction judge; without it stale facts remain rather than closing true ones. */
  readonly contradiction?: MemoryContradictionPort;
  readonly settings: MemorySettingsView;
  readonly audit?: MemoryAuditSink;
  readonly telemetry?: MemoryTelemetryPort;
  readonly now: () => Date;
  readonly newId: () => string;
  readonly confirmationTtlMs?: number;
}

/** Audit shape shared by every Memory write path; scope-and-count evidence only. */
export function auditEvent(
  request: MemoryScopeRequest,
  action: string,
  decision: "allow" | "deny",
  reasonCodes: readonly string[],
  occurredAt: Date,
  safeMetadata: Record<string, unknown>
): AuditEventInput {
  const principal = { principalId: request.principalId, businessId: request.businessId };
  return {
    actor: principal,
    effectivePrincipal: principal,
    ...(request.agentId === undefined ? {} : { agentId: request.agentId }),
    ...(request.runId === undefined ? {} : { runId: request.runId }),
    action,
    target: `memory:${request.businessId}`,
    decision,
    reasonCodes,
    correlationId: `${action}:${request.businessId}:${occurredAt.toISOString()}`,
    occurredAt,
    // Scope and counts only. The statement, subject, and evidence refs stay out of the ledger.
    safeMetadata,
  };
}
