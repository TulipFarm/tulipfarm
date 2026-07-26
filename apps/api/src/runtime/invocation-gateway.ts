import { randomUUID } from "node:crypto";

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
    readonly key: "invoke";
    readonly definitionRef: string;
    readonly resolvedInput: { readonly payloadRef: string };
  };
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
  readonly payloadRef: string;
  readonly idempotencyKey: string;
}

export type InvocationDenialCode =
  | "identity_substitution"
  | "inline_payload_denied"
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
  readonly nextId?: () => string;
  readonly now?: () => string;
}

function samePrincipal(left: InvocationPrincipal, right: InvocationPrincipal): boolean {
  return left.kind === right.kind && left.id === right.id;
}

/**
 * One persist-first boundary for every interactive, Trigger, channel, and Integration invocation.
 *
 * Protected input crosses this boundary only by Artifact reference. Identity substitution is
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
    if (!input.payloadRef.startsWith("artifact:")) {
      throw new InvocationDeniedError("inline_payload_denied");
    }
    if (!input.definitionRef.startsWith("published:")) {
      throw new InvocationDeniedError("unpublished_definition");
    }

    const runId = this.nextId();
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
      createdAt: this.now(),
      bundle: {
        digest: input.definitionRef,
        routineId: input.source,
        routineVersion: input.definitionRef,
      },
      state: {
        key: "invoke",
        definitionRef: input.definitionRef,
        resolvedInput: { payloadRef: input.payloadRef },
      },
    });
  }
}
