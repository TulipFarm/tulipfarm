/** Audit events carry only safe evidence; protected contents stay behind `BlobRef` ACLs. */

import type { BlobRef } from "@tulipfarm/storage";

export type AuditDecision = "allow" | "deny";

export type AuditInputErrorCode = "BUSINESS_MISMATCH" | "INVALID_INPUT" | "PROTECTED_PAYLOAD";

export class AuditInputError extends Error {
  constructor(
    public readonly code: AuditInputErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AuditInputError";
  }
}

/** Minimal principal reference. `@tulipfarm/audit` does not depend on `@tulipfarm/authz`. */
export interface AuditPrincipalRef {
  readonly principalId: string;
  readonly businessId: string;
}

/** Caller-supplied fields for one audit event, before chain linkage is computed. */
export interface AuditEventInput {
  readonly actor: AuditPrincipalRef;
  readonly effectivePrincipal: AuditPrincipalRef;
  readonly agentId?: string;
  readonly runId?: string;
  readonly stateId?: string;
  readonly action: string;
  readonly target: string;
  readonly decision: AuditDecision;
  readonly reasonCodes: readonly string[];
  readonly guardrailDigest?: string;
  readonly bundleDigest?: string;
  readonly sourceClassification?: string;
  readonly destinationClassification?: string;
  readonly requestHash?: string;
  readonly resultHash?: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly safeMetadata?: Record<string, unknown>;
  /** References to Artifacts holding sensitive contents, never the contents themselves. */
  readonly safeRefs?: readonly BlobRef[];
}

/** A stored, hash-linked audit event. `businessId` scopes the chain (one ledger per business). */
export interface AuditEvent extends AuditEventInput {
  readonly id: string;
  readonly businessId: string;
  readonly chainIndex: number;
  readonly previousHash: string | null;
  readonly hash: string;
}

const INPUT_KEYS = new Set([
  "actor",
  "effectivePrincipal",
  "agentId",
  "runId",
  "stateId",
  "action",
  "target",
  "decision",
  "reasonCodes",
  "guardrailDigest",
  "bundleDigest",
  "sourceClassification",
  "destinationClassification",
  "requestHash",
  "resultHash",
  "correlationId",
  "causationId",
  "occurredAt",
  "safeMetadata",
  "safeRefs",
]);

const PROTECTED_KEY =
  /^(?:body|content|message|payload|prompt|secret|password|passwd|token|credential|api[-_]?key|private[-_]?key)$/i;
const PROTECTED_VALUE: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9]{16,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
];

function invalid(message: string): never {
  throw new AuditInputError("INVALID_INPUT", message);
}

function protectedPayload(): never {
  throw new AuditInputError(
    "PROTECTED_PAYLOAD",
    "audit event contains payload data; store protected content as an Artifact reference"
  );
}

function safeString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    return invalid(`audit event ${field} must be a non-empty string`);
  }
  return value;
}

function cloneSafeMetadata(value: unknown, ancestors = new Set<object>()): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("audit event safeMetadata must be an object");
  }
  if (ancestors.has(value)) return invalid("audit event safeMetadata must not contain cycles");
  ancestors.add(value);
  const result: Record<string, unknown> = {};
  try {
    for (const [key, child] of Object.entries(value)) {
      if (PROTECTED_KEY.test(key)) protectedPayload();
      if (child === null || typeof child === "boolean") {
        result[key] = child;
      } else if (typeof child === "number") {
        if (!Number.isFinite(child)) return invalid("audit event safeMetadata must be finite");
        result[key] = child;
      } else if (typeof child === "string") {
        if (PROTECTED_VALUE.some((pattern) => pattern.test(child))) protectedPayload();
        result[key] = child;
      } else if (Array.isArray(child)) {
        result[key] = Object.freeze(
          child.map((item) => {
            if (
              item === null ||
              typeof item === "boolean" ||
              (typeof item === "number" && Number.isFinite(item))
            ) {
              return item;
            }
            if (typeof item === "string") {
              if (PROTECTED_VALUE.some((pattern) => pattern.test(item))) protectedPayload();
              return item;
            }
            return cloneSafeMetadata(item, ancestors);
          })
        );
      } else if (typeof child === "object") {
        result[key] = cloneSafeMetadata(child, ancestors);
      } else {
        return invalid("audit event safeMetadata contains an unsupported value");
      }
    }
  } finally {
    ancestors.delete(value);
  }
  return Object.freeze(result);
}

/** Snapshots safe input before hashing; rejects extra payload fields and cross-business actors. */
export function normalizeAuditEventInput(input: AuditEventInput): AuditEventInput {
  for (const key of Object.keys(input)) {
    if (!INPUT_KEYS.has(key)) protectedPayload();
  }
  const actorBusinessId = safeString(input.actor?.businessId, "actor.businessId");
  const effectiveBusinessId = safeString(
    input.effectivePrincipal?.businessId,
    "effectivePrincipal.businessId"
  );
  if (actorBusinessId !== effectiveBusinessId) {
    throw new AuditInputError(
      "BUSINESS_MISMATCH",
      "audit actor and effective principal must belong to the same business"
    );
  }
  if (!(input.occurredAt instanceof Date) || !Number.isFinite(input.occurredAt.getTime())) {
    return invalid("audit event occurredAt must be a valid Date");
  }
  if (input.decision !== "allow" && input.decision !== "deny") {
    return invalid("audit event decision is invalid");
  }
  if (
    !Array.isArray(input.reasonCodes) ||
    input.reasonCodes.some((code) => typeof code !== "string")
  ) {
    return invalid("audit event reasonCodes must contain strings");
  }

  const normalized: AuditEventInput = {
    actor: Object.freeze({
      principalId: safeString(input.actor.principalId, "actor.principalId"),
      businessId: actorBusinessId,
    }),
    effectivePrincipal: Object.freeze({
      principalId: safeString(
        input.effectivePrincipal.principalId,
        "effectivePrincipal.principalId"
      ),
      businessId: effectiveBusinessId,
    }),
    action: safeString(input.action, "action"),
    target: safeString(input.target, "target"),
    decision: input.decision,
    reasonCodes: Object.freeze([...input.reasonCodes]),
    correlationId: safeString(input.correlationId, "correlationId"),
    occurredAt: new Date(input.occurredAt.getTime()),
    ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(input.stateId !== undefined ? { stateId: input.stateId } : {}),
    ...(input.guardrailDigest !== undefined ? { guardrailDigest: input.guardrailDigest } : {}),
    ...(input.bundleDigest !== undefined ? { bundleDigest: input.bundleDigest } : {}),
    ...(input.sourceClassification !== undefined
      ? { sourceClassification: input.sourceClassification }
      : {}),
    ...(input.destinationClassification !== undefined
      ? { destinationClassification: input.destinationClassification }
      : {}),
    ...(input.requestHash !== undefined ? { requestHash: input.requestHash } : {}),
    ...(input.resultHash !== undefined ? { resultHash: input.resultHash } : {}),
    ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
    ...(input.safeMetadata !== undefined
      ? { safeMetadata: cloneSafeMetadata(input.safeMetadata) }
      : {}),
    ...(input.safeRefs !== undefined
      ? {
          safeRefs: Object.freeze(
            input.safeRefs.map((ref) => Object.freeze({ key: ref.key, hash: ref.hash }))
          ),
        }
      : {}),
  };
  return Object.freeze(normalized);
}
