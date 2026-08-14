/** Capability catalog: PostgreSQL is correctness-critical; optional accelerators only degrade. */

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

/** Required capabilities fail closed; optional ones degrade without losing authoritative state. */
export type CapabilityRequirement = "required" | "optional";

export interface CapabilityClassification {
  readonly id: CapabilityId;
  readonly requirement: CapabilityRequirement;
  /** True only when capability loss can corrupt or lose committed state; PostgreSQL alone. */
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

/** Missing required capabilities throw; missing optional accelerators do not. */
export function assertRequiredCapabilities(report: CapabilityReport): void {
  const missing = requiredCapabilityIds().filter((id) => !report.probes[id]?.available);
  if (missing.length > 0) {
    throw new MissingCapabilityError(missing);
  }
}
