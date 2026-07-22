/**
 * Provider-neutral infrastructure capability discovery.
 *
 * SPEC §22 requires ten operational backends to be provider-neutral ports "with
 * documented capability checks": PostgreSQL, blob, KMS, identity, model,
 * telemetry, vector search, cache, queue optimization, and sandbox. This module
 * makes that discovery explicit and typed and classifies each capability's
 * criticality so composition can fail closed on a missing required backend while
 * degrading gracefully without an optional one.
 *
 * Architectural invariant 16 (SPEC §5): no optional cache, queue, vector store,
 * or model provider is required for correctness. PostgreSQL is therefore the sole
 * correctness-critical capability; every other backend either fails closed
 * (required-to-serve) or degrades a feature (optional) without corrupting or
 * losing committed state.
 *
 * This catalog enumerates capability *ids* only. The port interfaces live with
 * their owning packages: transactions/blob/vector/cache/queue in
 * `@tulipfarm/storage`, KMS in `@tulipfarm/secrets`, sandbox in
 * `@tulipfarm/sandbox`, identity in `@tulipfarm/authz`, model in
 * `@tulipfarm/agent-runtime`, and telemetry here.
 */

export const CAPABILITY_IDS = [
  "postgres",
  "blob",
  "kms",
  "identity",
  "model",
  "telemetry",
  "vector",
  "cache",
  "queue",
  "sandbox",
] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];

/**
 * - `required`: the deployment must provide a backend for this port before it can
 *   serve protected work; a missing required capability fails closed.
 * - `optional`: omitting or losing the backend degrades a feature but never loses
 *   authoritative state or grants access.
 */
export type CapabilityRequirement = "required" | "optional";

export interface CapabilityClassification {
  readonly id: CapabilityId;
  readonly requirement: CapabilityRequirement;
  /**
   * True only for capabilities whose loss can corrupt or lose committed state.
   * Invariant 16 fixes this to PostgreSQL alone.
   */
  readonly correctnessCritical: boolean;
  readonly summary: string;
}

export const CAPABILITY_CLASSIFICATIONS: Readonly<Record<CapabilityId, CapabilityClassification>> =
  {
    postgres: {
      id: "postgres",
      requirement: "required",
      correctnessCritical: true,
      summary: "Transactional correctness core, inbox/outbox, and durable state.",
    },
    blob: {
      id: "blob",
      requirement: "required",
      correctnessCritical: false,
      summary: "Content-addressed large-payload store; filesystem/S3-compatible adapter.",
    },
    kms: {
      id: "kms",
      requirement: "required",
      correctnessCritical: false,
      summary: "Master-key provider wrapping data-encryption keys; fails closed, never plaintext.",
    },
    identity: {
      id: "identity",
      requirement: "required",
      correctnessCritical: false,
      summary: "Principal resolution / authentication backend (local credentials, OIDC).",
    },
    model: {
      id: "model",
      requirement: "optional",
      correctnessCritical: false,
      summary: "LLM provider behind ModelProfile; not required for correctness (invariant 16).",
    },
    telemetry: {
      id: "telemetry",
      requirement: "optional",
      correctnessCritical: false,
      summary: "OpenTelemetry export; loss degrades observability only.",
    },
    vector: {
      id: "vector",
      requirement: "optional",
      correctnessCritical: false,
      summary: "Vector-search accelerator (pgvector); never an ACL or correctness dependency.",
    },
    cache: {
      id: "cache",
      requirement: "optional",
      correctnessCritical: false,
      summary: "Ephemeral cache accelerator (Redis); its loss cannot lose authoritative state.",
    },
    queue: {
      id: "queue",
      requirement: "optional",
      correctnessCritical: false,
      summary: "Optional queue-optimization accelerator; the durable handoff stays in PostgreSQL.",
    },
    sandbox: {
      id: "sandbox",
      requirement: "optional",
      correctnessCritical: false,
      summary: "Isolated execution backend; production use requires strong-isolation attestation.",
    },
  };

export function classifyCapability(id: CapabilityId): CapabilityClassification {
  return CAPABILITY_CLASSIFICATIONS[id];
}

export function requiredCapabilityIds(): CapabilityId[] {
  return CAPABILITY_IDS.filter((id) => CAPABILITY_CLASSIFICATIONS[id].requirement === "required");
}

export function correctnessCriticalCapabilityIds(): CapabilityId[] {
  return CAPABILITY_IDS.filter((id) => CAPABILITY_CLASSIFICATIONS[id].correctnessCritical);
}

/** Result of probing one backend. `detail` must be safe, non-sensitive metadata. */
export interface CapabilityProbe {
  readonly id: CapabilityId;
  /** Provider-neutral adapter identifier, e.g. "postgres", "s3", "local-fs". Never a secret. */
  readonly provider: string;
  readonly available: boolean;
  readonly detail?: string;
}

export interface CapabilityReport {
  readonly probes: Readonly<Record<CapabilityId, CapabilityProbe>>;
}

export class MissingCapabilityError extends Error {
  readonly missing: readonly CapabilityId[];

  constructor(missing: readonly CapabilityId[]) {
    super(`missing required infrastructure capabilities: ${missing.join(", ")}`);
    this.name = "MissingCapabilityError";
    this.missing = missing;
  }
}

/**
 * Fail closed when any `required` capability is unavailable. Absent optional
 * accelerators (cache, vector, queue, telemetry, model, sandbox) never throw, so
 * a deployment stays correct after losing them.
 */
export function assertRequiredCapabilities(report: CapabilityReport): void {
  const missing = requiredCapabilityIds().filter((id) => !report.probes[id]?.available);
  if (missing.length > 0) {
    throw new MissingCapabilityError(missing);
  }
}
