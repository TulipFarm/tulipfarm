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
import type { MemoryScopeDenialReason, MemoryScopeRequest, MemoryScopeTarget } from "./scope";
import { authorizeMemoryScope } from "./scope";

export type MemoryOrigin = "explicit" | "inferred";
export type MemoryConfirmationState = "confirmed" | "pending" | "denied" | "expired";
export type MemoryStatus = "active" | "superseded" | "forgotten";

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
  readonly runId?: string;
  readonly evidence: readonly MemoryEvidenceRef[];
}

export interface MemoryAssertion {
  readonly assertionId: string;
  readonly businessId: string;
  readonly target: MemoryScopeTarget;
  readonly subject: string;
  readonly statement: string;
  /** 0–1. Explicit statements are 1; inferred ones carry the Agent's own confidence. */
  readonly confidence: number;
  readonly provenance: MemoryProvenance;
  readonly confirmation: MemoryConfirmationState;
  readonly status: MemoryStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
  readonly supersedesId?: string;
  readonly supersededById?: string;
}

export interface MemoryStore {
  put(assertion: MemoryAssertion): Promise<void>;
  get(businessId: string, assertionId: string): Promise<MemoryAssertion | undefined>;
  /** Every assertion in the business, whatever its status — recall does its own filtering. */
  list(businessId: string): Promise<readonly MemoryAssertion[]>;
  listActive(businessId: string): Promise<readonly MemoryAssertion[]>;
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
  readonly settings: MemorySettingsView;
  readonly audit?: MemoryAuditSink;
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
  /** Set to edit: the prior version is superseded rather than overwritten. */
  readonly supersedesId?: string;
  readonly expiresAt?: string;
}

export type RememberDenialReason =
  | MemoryScopeDenialReason
  | "inferred_memory_disabled"
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
  const assertion: MemoryAssertion = {
    assertionId: deps.newId(),
    businessId: scopeRequest.businessId,
    target: request.target,
    subject: request.subject,
    statement: request.statement,
    confidence: request.confidence,
    provenance: request.provenance,
    confirmation: "confirmed",
    status: "active",
    version,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(request.supersedesId === undefined ? {} : { supersedesId: request.supersedesId }),
  };

  await deps.store.put(assertion);
  if (prior !== undefined) {
    await deps.store.put({
      ...prior,
      status: "superseded",
      supersededById: assertion.assertionId,
      updatedAt: now.toISOString(),
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
  const existing = await deps.store.get(request.businessId, request.assertionId);
  if (existing === undefined) return { outcome: "not_found" };

  const access = authorizeMemoryScope(deps.settings.scopes, existing.target, scopeRequest);
  if (!access.allowed) {
    await deps.audit?.record(
      auditEvent(scopeRequest, "memory.forget", "deny", [access.reason], now, {
        scope: existing.target.scope,
      })
    );
    return { outcome: "denied", reason: access.reason };
  }

  const tombstone: MemoryAssertion = {
    ...existing,
    statement: "",
    status: "forgotten",
    updatedAt: now.toISOString(),
  };
  await deps.store.put(tombstone);
  await deps.audit?.record(
    auditEvent(scopeRequest, "memory.forget", "allow", [], now, {
      scope: existing.target.scope,
      version: existing.version,
    })
  );
  return { outcome: "forgotten", assertion: tombstone };
}
