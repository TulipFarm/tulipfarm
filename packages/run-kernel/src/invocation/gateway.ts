import { randomUUID } from "node:crypto";
import type { PublishArtifactInput } from "../artifacts";
import { TypedOutputError, type TypedOutputValidator } from "../outputs";

export const INVOCATION_SOURCES = [
  "chat",
  "manual",
  "webhook",
  "schedule",
  "channel",
  "integration",
] as const;

export type InvocationSource = (typeof INVOCATION_SOURCES)[number];

export const RUN_SOURCES = ["chat", "integration", "routine", "curator"] as const;
export type RunSource = (typeof RUN_SOURCES)[number];

export interface InvocationPrincipal {
  readonly kind: string;
  readonly id: string;
}

export const INVOKE_STATE_KEY = "invoke";

export const RUN_EXECUTOR_PRINCIPAL_REF = "service:run-executor";

export function requestArtifactId(runId: string): string {
  return `${runId}:request`;
}

export function requestPayloadRef(runId: string): string {
  return `artifact:${requestArtifactId(runId)}`;
}

/**
 * Derived Chat request Artifact id; Integration envelopes stay raw, with `derived_from` lineage.
 */
export function chatRequestArtifactId(runId: string): string {
  return `${runId}:chat-request`;
}

export interface DurableInvocationRecord {
  readonly runId: string;
  readonly source: InvocationSource;
  readonly runSource: RunSource;
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
    readonly key: string;
    readonly definitionRef: string;
    readonly resolvedInput: { readonly payloadRef: string };
  };
  /** Request Artifact committed with the Run so a restarted Worker can read the exact input. */
  readonly requestArtifact: PublishArtifactInput;
}

export interface DurableInvocationStore {
  persist(
    record: DurableInvocationRecord
  ): Promise<{ readonly outcome: "started" | "duplicate"; readonly runId: string }>;
}

export interface ResolvedRoutineInvocation {
  readonly bundle: {
    readonly digest: string;
    readonly routineId: string;
    readonly routineVersion: string;
  };
  readonly startState: {
    readonly key: string;
    readonly definitionRef: string;
  };
}

/** Port for verified active Routine resolution; run-kernel must not import `@tulipfarm/soul`. */
export interface RoutineInvocationResolver {
  resolve(input: {
    readonly businessId: string;
    readonly definitionRef: string;
  }): Promise<ResolvedRoutineInvocation | undefined>;
}

export interface StartInvocationInput {
  readonly source: InvocationSource;
  readonly runSource: RunSource;
  readonly businessId: string;
  readonly initiator: InvocationPrincipal;
  readonly effectiveSubject: InvocationPrincipal;
  readonly identityMappingEvidenceRef?: string;
  readonly definitionRef: string;
  readonly payload: unknown;
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
  readonly validator: TypedOutputValidator;
  /** Required for Routine Runs. Its absence denies rather than manufacturing a nominal pin. */
  readonly routineDefinitions?: RoutineInvocationResolver;
  readonly nextId?: () => string;
  readonly now?: () => string;
}

function samePrincipal(left: InvocationPrincipal, right: InvocationPrincipal): boolean {
  return left.kind === right.kind && left.id === right.id;
}

/**
 * Persist-first invocation boundary: protected input becomes an Artifact committed with the Run
 * and first State; identity substitution needs opaque evidence, not authority.
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
      !RUN_SOURCES.includes(input.runSource) ||
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

    const routineDefinition =
      input.runSource === "routine"
        ? await this.options.routineDefinitions?.resolve({
            businessId: input.businessId,
            definitionRef: input.definitionRef,
          })
        : undefined;
    if (input.runSource === "routine" && routineDefinition === undefined) {
      throw new InvocationDeniedError("unpublished_definition");
    }

    const bundle = routineDefinition?.bundle ?? {
      digest: input.definitionRef,
      routineId: input.runSource,
      routineVersion: input.definitionRef,
    };
    const initialState = routineDefinition?.startState ?? {
      key: INVOKE_STATE_KEY,
      definitionRef: input.definitionRef,
    };
    if (
      bundle.digest.length === 0 ||
      bundle.routineId.length === 0 ||
      bundle.routineVersion.length === 0 ||
      initialState.key.length === 0 ||
      initialState.definitionRef.length === 0
    ) {
      throw new InvocationDeniedError("invalid_invocation");
    }

    const runId = this.nextId();
    const createdAt = this.now();
    return this.options.store.persist({
      runId,
      source: input.source,
      runSource: input.runSource,
      businessId: input.businessId,
      initiator: input.initiator,
      effectiveSubject: input.effectiveSubject,
      ...(input.identityMappingEvidenceRef === undefined
        ? {}
        : { identityMappingEvidenceRef: input.identityMappingEvidenceRef }),
      idempotencyKey: input.idempotencyKey,
      createdAt,
      bundle,
      state: {
        key: initialState.key,
        definitionRef: initialState.definitionRef,
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
        producer: { runId, stateKey: initialState.key, attempt: 0 },
        createdAt,
      },
    });
  }
}
