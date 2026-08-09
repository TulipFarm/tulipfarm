/**
 * Versioned, scoped Memory assertions (SPEC §14.2).
 *
 * This replaces the flat "remember this string" model: every durable statement is an assertion
 * carrying its scope owner, provenance, evidence, confidence, confirmation state, expiry, and
 * version lineage. Nothing is ever overwritten — an edit writes a new version and supersedes the
 * old one, so what an Agent believed and why stays auditable.
 *
 * Two rules are absolute here:
 * - a save is authorized against the scope's *owner*, never against the caller's general authority;
 * - an inferred statement never becomes durable without explicit confirmation. `rememberMemory`
 *   parks it as a pending record and writes nothing to the assertion store.
 */

import type { AuditEventInput } from "@tulipfarm/audit";
import type { MemoryScope, MemorySettingsDefinition } from "@tulipfarm/schema";
import type { PendingMemoryStore } from "./confirm";
import { DEFAULT_CONFIRMATION_TTL_MS } from "./confirm";
import type { MemoryContradictionPort } from "./contradiction";
import { resolveContradictions } from "./contradiction";
import type { MemoryRecallIndex } from "./retrieve";
import type { MemoryScopeDenialReason, MemoryScopeRequest, MemoryScopeTarget } from "./scope";
import { authorizeMemoryScope } from "./scope";
import {
  endMemorySpan,
  MEMORY_METRICS,
  MEMORY_SPANS,
  type MemoryTelemetryPort,
  recordMemoryCounter,
  recordMemorySpanError,
  setMemorySpanAttributes,
  startMemorySpan,
} from "./telemetry";

export type MemoryOrigin = "explicit" | "inferred";
export type MemoryConfirmationState = "confirmed" | "pending" | "denied" | "expired";
export type MemoryStatus = "active" | "superseded" | "forgotten";

/** What kind of thing an assertion says, which decides how it is recalled and rendered. */
export const MEMORY_TYPES = ["preference", "fact", "procedural", "episodic"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/**
 * How far an assertion's origin is trusted, most to least. The tier is a property of where the
 * statement came from, never of who saved it: text that arrived from an external Knowledge source
 * is `external_derived` even when an Agent with broad authority chose to save it.
 */
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
  /**
   * Transaction time, closing half. `createdAt` is when this belief started being held;
   * `recordedUntil` is when it stopped — set when the assertion is superseded or forgotten, and
   * absent while the belief is current. Paired with `validFrom`/`validTo`, this makes the store
   * bi-temporal: *when we believed it* is recorded separately from *when it was true*.
   */
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

/**
 * Names one scope owner exactly, for store queries that must not scan the whole business.
 * This is a *lookup* filter, never an authorization decision — `authorizeMemoryScope` still runs
 * on everything a store returns.
 */
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
  /**
   * Active assertions owned by one scope, oldest-created first. A durable store cannot answer
   * `listActive` for a whole business cheaply, so every caller that already knows whose memory it
   * wants asks for that owner directly.
   */
  listActiveForScope(
    businessId: string,
    filter: MemoryScopeFilter
  ): Promise<readonly MemoryAssertion[]>;
  /**
   * Fetch a specific set of assertions. Retrieval ranks ids before it has rows, so the alternative
   * is loading the business to find a handful of them.
   */
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

export function memorySettingsView(definition: MemorySettingsDefinition): MemorySettingsView {
  return {
    scopes: definition.spec.scopes,
    inferredDurableMemory: definition.spec.inferredDurableMemory,
    ...(definition.spec.defaultExpiryDays === undefined
      ? {}
      : { defaultExpiryDays: definition.spec.defaultExpiryDays }),
  };
}

/**
 * Reauthorizes the Knowledge sources an assertion was derived from. Memory may not import
 * `@tulipfarm/knowledge` (see `docs/architecture/dependency-rules.md`), and it must not cache that
 * decision, so the composing application supplies this port. `undefined` means "could not be
 * established", which denies — the same fail-closed rule Knowledge itself applies.
 */
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
  /**
   * Relevance retrieval. Optional: with no index wired, recall falls back to recency ordering
   * rather than failing, so an unindexed deployment degrades instead of breaking.
   */
  readonly index?: MemoryRecallIndex;
  /**
   * Judges whether a new statement contradicts one already stored. Optional: with none wired,
   * nothing is ever auto-invalidated, which leaves a stale fact in recall rather than risking the
   * removal of a true one.
   */
  readonly contradiction?: MemoryContradictionPort;
  readonly settings: MemorySettingsView;
  readonly audit?: MemoryAuditSink;
  readonly telemetry?: MemoryTelemetryPort;
  readonly now: () => Date;
  readonly newId: () => string;
  readonly confirmationTtlMs?: number;
}

export interface RememberRequest {
  readonly target: MemoryScopeTarget;
  readonly subject: string;
  readonly statement: string;
  readonly confidence: number;
  readonly provenance: MemoryProvenance;
  /** Defaults to `fact` — the least behaviour-changing kind. */
  readonly memoryType?: MemoryType;
  /**
   * Defaults from the origin: an explicit save is `user_stated`, an inferred one
   * `agent_inferred`. A caller ingesting external content must pass `external_derived` itself,
   * because only the caller knows where the text came from.
   */
  readonly trustTier?: MemoryTrustTier;
  /** Defaults to `confidence` when unset. */
  readonly importance?: number;
  readonly entities?: readonly string[];
  /** When the statement started being true. Defaults to now — i.e. "as of when we heard it". */
  readonly validFrom?: string;
  readonly validTo?: string;
  /** Set to edit: the prior version is superseded rather than overwritten. */
  readonly supersedesId?: string;
  readonly expiresAt?: string;
}

export type RememberDenialReason =
  | MemoryScopeDenialReason
  | "inferred_memory_disabled"
  | "procedural_requires_explicit_correction"
  | "supersedes_not_found"
  | "supersedes_scope_mismatch";

export type RememberResult =
  | { readonly outcome: "saved"; readonly assertion: MemoryAssertion }
  | { readonly outcome: "pending_confirmation"; readonly pendingId: string }
  | { readonly outcome: "denied"; readonly reason: RememberDenialReason };

function auditEvent(
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

function expiryFrom(
  request: RememberRequest,
  settings: MemorySettingsView,
  now: Date
): string | undefined {
  if (request.expiresAt !== undefined) return request.expiresAt;
  if (settings.defaultExpiryDays === undefined) return undefined;
  return new Date(now.getTime() + settings.defaultExpiryDays * 86_400_000).toISOString();
}

/**
 * Build the durable assertion for an authorized save, superseding a prior version when asked.
 * Shared with the confirmation path so a confirmed inferred memory lands identically.
 */
export async function commitAssertion(
  deps: MemoryDeps,
  request: RememberRequest,
  scopeRequest: MemoryScopeRequest
): Promise<{ ok: true; assertion: MemoryAssertion } | { ok: false; reason: RememberDenialReason }> {
  const now = deps.now();
  let version = 1;
  let prior: MemoryAssertion | undefined;

  if (request.supersedesId !== undefined) {
    prior = await deps.store.get(scopeRequest.businessId, request.supersedesId);
    if (prior === undefined) return { ok: false, reason: "supersedes_not_found" };
    // Editing is a write to the *prior* assertion's scope as well as the new one.
    const priorAccess = authorizeMemoryScope(deps.settings.scopes, prior.target, scopeRequest);
    if (!priorAccess.allowed) return { ok: false, reason: "supersedes_scope_mismatch" };
    version = prior.version + 1;
  }

  const expiresAt = expiryFrom(request, deps.settings, now);
  const nowIso = now.toISOString();
  const assertion: MemoryAssertion = {
    assertionId: deps.newId(),
    businessId: scopeRequest.businessId,
    target: request.target,
    subject: request.subject,
    statement: request.statement,
    memoryType: request.memoryType ?? "fact",
    trustTier:
      request.trustTier ??
      (request.provenance.origin === "explicit" ? "user_stated" : "agent_inferred"),
    confidence: request.confidence,
    importance: request.importance ?? request.confidence,
    provenance: request.provenance,
    confirmation: "confirmed",
    status: "active",
    version,
    createdAt: nowIso,
    updatedAt: nowIso,
    validFrom: request.validFrom ?? nowIso,
    ...(request.validTo === undefined ? {} : { validTo: request.validTo }),
    entities: request.entities ?? [],
    accessCount: 0,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(request.supersedesId === undefined ? {} : { supersedesId: request.supersedesId }),
  };

  await deps.store.put(assertion);
  recordMemoryCounter(deps.telemetry, MEMORY_METRICS.assertionWrites, 1, {
    scope: assertion.target.scope,
    memory_type: assertion.memoryType,
    trust_tier: assertion.trustTier,
    origin: assertion.provenance.origin,
  });
  // Contradiction handling runs after the write, never before it: the statement is already durable,
  // so a judge that is absent or fails costs a stale row in recall rather than the write itself.
  // An explicit edit skips it — the caller already named exactly what it replaces.
  if (prior === undefined) {
    await resolveContradictions(deps, assertion, scopeRequest, deps.contradiction);
  }
  if (prior !== undefined) {
    // Superseding closes the prior belief's transaction time. Its valid time is left alone here —
    // deciding *when the old statement stopped being true* is contradiction handling, not editing.
    await deps.store.put({
      ...prior,
      status: "superseded",
      supersededById: assertion.assertionId,
      recordedUntil: nowIso,
      updatedAt: nowIso,
    });
  }
  return { ok: true, assertion };
}

/**
 * Save a statement, or park it for confirmation.
 *
 * Explicit and authorized saves land immediately. Inferred statements never do: they become a
 * pending record that only becomes durable through {@link resolvePendingMemory}, and if the Agent's
 * MemorySettings disable inferred durable memory they are refused outright.
 */
export async function rememberMemory(
  deps: MemoryDeps,
  request: RememberRequest,
  scopeRequest: MemoryScopeRequest
): Promise<RememberResult> {
  const now = deps.now();
  const access = authorizeMemoryScope(deps.settings.scopes, request.target, scopeRequest);
  if (!access.allowed) {
    await deps.audit?.record(
      auditEvent(scopeRequest, "memory.save", "deny", [access.reason], now, {
        scope: request.target.scope,
        origin: request.provenance.origin,
      })
    );
    return { outcome: "denied", reason: access.reason };
  }

  if (
    request.memoryType === "procedural" &&
    (request.provenance.origin !== "explicit" || request.trustTier !== "user_stated")
  ) {
    await deps.audit?.record(
      auditEvent(
        scopeRequest,
        "memory.save",
        "deny",
        ["procedural_requires_explicit_correction"],
        now,
        {
          scope: request.target.scope,
          origin: request.provenance.origin,
        }
      )
    );
    return { outcome: "denied", reason: "procedural_requires_explicit_correction" };
  }

  if (request.provenance.origin === "inferred") {
    if (!deps.settings.inferredDurableMemory.enabled) {
      await deps.audit?.record(
        auditEvent(scopeRequest, "memory.save", "deny", ["inferred_memory_disabled"], now, {
          scope: request.target.scope,
          origin: "inferred",
        })
      );
      return { outcome: "denied", reason: "inferred_memory_disabled" };
    }

    const pendingId = deps.newId();
    await deps.pending.put({
      pendingId,
      businessId: scopeRequest.businessId,
      request,
      requestedAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + (deps.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS)
      ).toISOString(),
    });
    await deps.audit?.record(
      auditEvent(scopeRequest, "memory.save", "allow", ["confirmation_required"], now, {
        scope: request.target.scope,
        origin: "inferred",
        durable: false,
      })
    );
    return { outcome: "pending_confirmation", pendingId };
  }

  const committed = await commitAssertion(deps, request, scopeRequest);
  if (!committed.ok) {
    await deps.audit?.record(
      auditEvent(scopeRequest, "memory.save", "deny", [committed.reason], now, {
        scope: request.target.scope,
        origin: "explicit",
      })
    );
    return { outcome: "denied", reason: committed.reason };
  }

  await deps.audit?.record(
    auditEvent(scopeRequest, "memory.save", "allow", [], now, {
      scope: request.target.scope,
      origin: "explicit",
      version: committed.assertion.version,
      durable: true,
    })
  );
  return { outcome: "saved", assertion: committed.assertion };
}

export interface ProceduralCorrectionRequest {
  readonly target: MemoryScopeTarget;
  readonly subject: string;
  readonly statement: string;
  readonly authorPrincipalId: string;
  readonly authorAgentId?: string;
  readonly runId?: string;
  readonly evidence?: readonly MemoryEvidenceRef[];
  readonly entities?: readonly string[];
}

/**
 * Records an explicit human correction as procedural Memory.
 *
 * This is the narrow M6 write path: procedural assertions are user-stated corrections, never
 * background extraction output. The generic extractor still refuses `procedural` candidates before
 * they can become Pending Memory.
 */
export function rememberProceduralCorrection(
  deps: MemoryDeps,
  request: ProceduralCorrectionRequest,
  scopeRequest: MemoryScopeRequest
): Promise<RememberResult> {
  return rememberMemory(
    deps,
    {
      target: request.target,
      subject: request.subject,
      statement: request.statement,
      confidence: 1,
      importance: 1,
      memoryType: "procedural",
      trustTier: "user_stated",
      provenance: {
        origin: "explicit",
        authorPrincipalId: request.authorPrincipalId,
        ...(request.authorAgentId === undefined ? {} : { authorAgentId: request.authorAgentId }),
        ...(request.runId === undefined ? {} : { runId: request.runId }),
        evidence: request.evidence ?? [],
      },
      entities: request.entities ?? [],
    },
    scopeRequest
  );
}

export interface ForgetRequest {
  readonly businessId: string;
  readonly assertionId: string;
}

export type ForgetResult =
  | { readonly outcome: "forgotten"; readonly assertion: MemoryAssertion }
  | { readonly outcome: "denied"; readonly reason: MemoryScopeDenialReason }
  | { readonly outcome: "not_found" };

/**
 * Forget an assertion: the record survives as a tombstone for lineage, its statement does not.
 * Keeping the text of a "forgotten" memory would make forgetting a lie.
 */
export async function forgetMemory(
  deps: MemoryDeps,
  request: ForgetRequest,
  scopeRequest: MemoryScopeRequest
): Promise<ForgetResult> {
  const now = deps.now();
  const span = startMemorySpan(deps.telemetry, MEMORY_SPANS.forget);
  const existing = await deps.store.get(request.businessId, request.assertionId);
  if (existing === undefined) {
    recordMemoryCounter(deps.telemetry, MEMORY_METRICS.forgetOperations, 1, {
      outcome: "not_found",
    });
    setMemorySpanAttributes(span, { outcome: "not_found" });
    endMemorySpan(span);
    return { outcome: "not_found" };
  }

  const access = authorizeMemoryScope(deps.settings.scopes, existing.target, scopeRequest);
  if (!access.allowed) {
    await deps.audit?.record(
      auditEvent(scopeRequest, "memory.forget", "deny", [access.reason], now, {
        scope: existing.target.scope,
      })
    );
    recordMemoryCounter(deps.telemetry, MEMORY_METRICS.forgetOperations, 1, {
      outcome: "denied",
      reason: access.reason,
      scope: existing.target.scope,
    });
    setMemorySpanAttributes(span, {
      outcome: "denied",
      reason: access.reason,
      scope: existing.target.scope,
    });
    endMemorySpan(span);
    return { outcome: "denied", reason: access.reason };
  }

  const tombstone: MemoryAssertion = {
    ...existing,
    statement: "",
    // Entities are derived from the statement, so leaving them would leak what was forgotten.
    entities: [],
    status: "forgotten",
    recordedUntil: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await deps.store.put(tombstone);
  await deps.audit?.record(
    auditEvent(scopeRequest, "memory.forget", "allow", [], now, {
      scope: existing.target.scope,
      version: existing.version,
    })
  );
  recordMemoryCounter(deps.telemetry, MEMORY_METRICS.forgetOperations, 1, {
    outcome: "forgotten",
    scope: existing.target.scope,
    memory_type: existing.memoryType,
  });
  setMemorySpanAttributes(span, {
    outcome: "forgotten",
    scope: existing.target.scope,
    memory_type: existing.memoryType,
  });
  endMemorySpan(span);
  return { outcome: "forgotten", assertion: tombstone };
}

export type EraseResult =
  | { readonly outcome: "erased"; readonly counts: MemoryEraseCounts }
  | { readonly outcome: "denied"; readonly reason: MemoryScopeDenialReason }
  | { readonly outcome: "not_found" };

/**
 * Erase an assertion: remove the row and every derived copy the store can reach.
 *
 * Audit proves that an erase happened, but records only scope, version, and abstract counts. The
 * erased subject, statement, evidence refs, and assertion id deliberately stay out of it.
 */
export async function eraseMemory(
  deps: MemoryDeps,
  request: ForgetRequest,
  scopeRequest: MemoryScopeRequest
): Promise<EraseResult> {
  const now = deps.now();
  const span = startMemorySpan(deps.telemetry, MEMORY_SPANS.erase);
  const existing = await deps.store.get(request.businessId, request.assertionId);
  if (existing === undefined) {
    recordMemoryCounter(deps.telemetry, MEMORY_METRICS.eraseOperations, 1, {
      outcome: "not_found",
    });
    setMemorySpanAttributes(span, { outcome: "not_found" });
    endMemorySpan(span);
    return { outcome: "not_found" };
  }

  const access = authorizeMemoryScope(deps.settings.scopes, existing.target, scopeRequest);
  if (!access.allowed) {
    await deps.audit?.record(
      auditEvent(scopeRequest, "memory.erase", "deny", [access.reason], now, {
        scope: existing.target.scope,
      })
    );
    recordMemoryCounter(deps.telemetry, MEMORY_METRICS.eraseOperations, 1, {
      outcome: "denied",
      reason: access.reason,
      scope: existing.target.scope,
    });
    setMemorySpanAttributes(span, {
      outcome: "denied",
      reason: access.reason,
      scope: existing.target.scope,
    });
    endMemorySpan(span);
    return { outcome: "denied", reason: access.reason };
  }

  let pending: number;
  try {
    pending = await deps.pending.deleteReferencingAssertion(
      request.businessId,
      request.assertionId,
      existing.statement
    );
  } catch (error) {
    recordMemoryCounter(deps.telemetry, MEMORY_METRICS.eraseCascadeFailures, 1, {
      stage: "pending",
      scope: existing.target.scope,
    });
    recordMemorySpanError(span, "pending_cascade_failed");
    endMemorySpan(span);
    throw error;
  }

  let storeCounts: MemoryEraseStoreCounts;
  try {
    storeCounts = await deps.store.erase(existing);
  } catch (error) {
    recordMemoryCounter(deps.telemetry, MEMORY_METRICS.eraseCascadeFailures, 1, {
      stage: "store",
      scope: existing.target.scope,
    });
    recordMemorySpanError(span, "store_cascade_failed");
    endMemorySpan(span);
    throw error;
  }
  const counts: MemoryEraseCounts = { ...storeCounts, pending };
  for (const [stage, count] of Object.entries(counts)) {
    recordMemoryCounter(deps.telemetry, MEMORY_METRICS.eraseCascadeCounts, count, {
      stage,
      scope: existing.target.scope,
    });
  }
  await deps.audit?.record(
    auditEvent(scopeRequest, "memory.erase", "allow", [], now, {
      scope: existing.target.scope,
      version: existing.version,
      counts,
    })
  );
  recordMemoryCounter(deps.telemetry, MEMORY_METRICS.eraseOperations, 1, {
    outcome: "erased",
    scope: existing.target.scope,
    memory_type: existing.memoryType,
  });
  setMemorySpanAttributes(span, {
    outcome: "erased",
    scope: existing.target.scope,
    memory_type: existing.memoryType,
  });
  endMemorySpan(span);
  return { outcome: "erased", counts };
}
