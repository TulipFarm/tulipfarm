/** Explicit/inferred write path: confirmation gating, procedural correction, and supersession. */

import { DEFAULT_CONFIRMATION_TTL_MS } from "./confirm";
import { resolveContradictions } from "./contradiction";
import {
  auditEvent,
  type MemoryAssertion,
  type MemoryDeps,
  type MemoryEvidenceRef,
  type MemoryProvenance,
  type MemorySettingsView,
  type MemoryTrustTier,
  type MemoryType,
} from "./memory";
import type { MemoryScopeDenialReason, MemoryScopeRequest, MemoryScopeTarget } from "./scope";
import { authorizeMemoryScope } from "./scope";
import { MEMORY_METRICS, recordMemoryCounter } from "./telemetry";

export interface RememberRequest {
  readonly target: MemoryScopeTarget;
  readonly subject: string;
  readonly statement: string;
  readonly confidence: number;
  readonly provenance: MemoryProvenance;
  /** Defaults to `fact` — the least behaviour-changing kind. */
  readonly memoryType?: MemoryType;
  /** Defaults from origin; callers must mark external content themselves. */
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

function expiryFrom(
  request: RememberRequest,
  settings: MemorySettingsView,
  now: Date
): string | undefined {
  if (request.expiresAt !== undefined) return request.expiresAt;
  if (settings.defaultExpiryDays === undefined) return undefined;
  return new Date(now.getTime() + settings.defaultExpiryDays * 86_400_000).toISOString();
}

/** Builds the durable assertion for save and confirmation, superseding prior versions when asked. */
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

/** Explicit saves land immediately; inferred statements become pending or are refused by settings. */
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

/** Records a human procedural correction; extraction cannot create procedural Memory. */
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
