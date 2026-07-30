import { randomUUID } from "node:crypto";
import {
  type PublishArtifactInput,
  TypedOutputError,
  type TypedOutputValidator,
} from "@tulipfarm/run-kernel";

export const INVOCATION_SOURCES = [
  "chat",
  "manual",
  "webhook",
  "schedule",
  "channel",
  "integration",
] as const;

export type InvocationSource = (typeof INVOCATION_SOURCES)[number];

export interface InvocationPrincipal {
  readonly kind: string;
  readonly id: string;
}

/** The single State every invocation starts on, and the Artifact producer it is recorded under. */
export const INVOKE_STATE_KEY = "invoke";

/** Principal the Run executor reads request Artifacts as; every request ACL must include it. */
export const RUN_EXECUTOR_PRINCIPAL_REF = "service:run-executor";

/** Identity of the Artifact holding the request that minted `runId`. */
export function requestArtifactId(runId: string): string {
  return `${runId}:request`;
}

/** The `payloadRef` a State carries for `runId`, resolvable through `ArtifactService.read`. */
export function requestPayloadRef(runId: string): string {
  return `artifact:${requestArtifactId(runId)}`;
}

export interface DurableInvocationRecord {
  readonly runId: string;
  readonly source: InvocationSource;
  readonly businessId: string;
  readonly initiator: InvocationPrincipal;
  readonly effectiveSubject: InvocationPrincipal;
  readonly identityMappingEvidenceRef?: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly bundle: {
    readonly digest: string;
    readonly routineId: string;
    readonly routineVersion: string;
  };
  readonly state: {
    readonly key: typeof INVOKE_STATE_KEY;
    readonly definitionRef: string;
    readonly resolvedInput: { readonly payloadRef: string };
  };
  /**
   * The request itself, published as an immutable Artifact in the same transaction as the Run. This
   * is what makes the Run reconstructable: the State's `payloadRef` names this Artifact, so a Worker
   * that picks the Run up after an API crash can read the exact input the request carried.
   */
  readonly requestArtifact: PublishArtifactInput;
}

export interface DurableInvocationStore {
  persist(
    record: DurableInvocationRecord
  ): Promise<{ readonly outcome: "started" | "duplicate"; readonly runId: string }>;
}

export interface StartInvocationInput {
  readonly source: InvocationSource;
  readonly businessId: string;
  readonly initiator: InvocationPrincipal;
  readonly effectiveSubject: InvocationPrincipal;
  readonly identityMappingEvidenceRef?: string;
  readonly definitionRef: string;
  /** The request payload, stored verbatim as the Run's request Artifact. */
  readonly payload: unknown;
  /** Which registered schema the payload must satisfy; an unregistered ref is denied. */
  readonly payloadSchemaRef: string;
  readonly idempotencyKey: string;
}

export type InvocationDenialCode =
  | "identity_substitution"
  | "invalid_payload"
  | "unpublished_definition"
  | "invalid_invocation";

export class InvocationDeniedError extends Error {
  readonly name = "InvocationDeniedError";

  constructor(readonly code: InvocationDenialCode) {
    super(code);
  }
}

export interface DurableInvocationGatewayOptions {
  readonly store: DurableInvocationStore;
  /** Compiled over `INVOCATION_REQUEST_SCHEMAS`; the gateway accepts no unregistered schema. */
  readonly validator: TypedOutputValidator;
  readonly nextId?: () => string;
  readonly now?: () => string;
}

function samePrincipal(left: InvocationPrincipal, right: InvocationPrincipal): boolean {
  return left.kind === right.kind && left.id === right.id;
}

/**
 * One persist-first boundary for every interactive, Trigger, channel, and Integration invocation.
 *
 * Protected input crosses this boundary only by Artifact reference, and the gateway is what creates
 * that Artifact: the caller hands over the payload plus the schema it claims to satisfy, and the
 * store commits the Artifact, the Run, and its first State together. Identity substitution is
 * denied unless the mapping service supplied an opaque evidence reference; the evidence grants no
 * authority by itself and remains available to downstream authorization and audit.
 */
export class DurableInvocationGateway {
  private readonly nextId: () => string;
  private readonly now: () => string;

  constructor(private readonly options: DurableInvocationGatewayOptions) {
    this.nextId = options.nextId ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async start(input: StartInvocationInput) {
    if (
      input.businessId.length === 0 ||
      input.idempotencyKey.length === 0 ||
      input.initiator.id.length === 0 ||
      input.effectiveSubject.id.length === 0
    ) {
      throw new InvocationDeniedError("invalid_invocation");
    }
    if (
      !samePrincipal(input.initiator, input.effectiveSubject) &&
      input.identityMappingEvidenceRef === undefined
    ) {
      throw new InvocationDeniedError("identity_substitution");
    }
    if (!input.definitionRef.startsWith("published:")) {
      throw new InvocationDeniedError("unpublished_definition");
    }
    // Validate before a `runId` exists. A malformed payload or an unregistered schema reference must
    // leave no trace: no Run to reconcile, no Artifact naming a Run that was never created.
    try {
      this.options.validator.validate(input.payloadSchemaRef, input.payload);
    } catch (error) {
      if (error instanceof TypedOutputError) throw new InvocationDeniedError("invalid_payload");
      throw error;
    }

    const runId = this.nextId();
    const createdAt = this.now();
    return this.options.store.persist({
      runId,
      source: input.source,
      businessId: input.businessId,
      initiator: input.initiator,
      effectiveSubject: input.effectiveSubject,
      ...(input.identityMappingEvidenceRef === undefined
        ? {}
        : { identityMappingEvidenceRef: input.identityMappingEvidenceRef }),
      idempotencyKey: input.idempotencyKey,
      createdAt,
      bundle: {
        digest: input.definitionRef,
        routineId: input.source,
        routineVersion: input.definitionRef,
      },
      state: {
        key: INVOKE_STATE_KEY,
        definitionRef: input.definitionRef,
        resolvedInput: { payloadRef: requestPayloadRef(runId) },
      },
      requestArtifact: {
        id: requestArtifactId(runId),
        businessId: input.businessId,
        schemaRef: input.payloadSchemaRef,
        value: input.payload,
        storage: "inline",
        // No classification vocabulary is enforced anywhere yet; labels nothing reads would be
        // ceremony that later policy work would have to reconcile against.
        classification: [],
        // Artifact rows are append-only, so an ACL missing a reader can never be corrected. Both
        // principals and the Run executor go in on the first write.
        acl: {
          readers: [
            ...new Set([
              `${input.initiator.kind}:${input.initiator.id}`,
              `${input.effectiveSubject.kind}:${input.effectiveSubject.id}`,
              RUN_EXECUTOR_PRINCIPAL_REF,
            ]),
          ],
        },
        retention: { policy: "standard", expiresAt: null },
        redaction: { redactedPaths: [] },
        producer: { runId, stateKey: INVOKE_STATE_KEY, attempt: 0 },
        createdAt,
      },
    });
  }
}
