import { type LiveArtifactKind, type PinnedArtifactKind, temporalClassOf } from "@tulipfarm/schema";
import { type BundleDefinition, BundleError, type BundleStore, type RuntimeBundle } from "./bundle";
import type { BundleVerifier } from "./signatures";
import { verifyExecutionBundle } from "./signatures";

/** Exact authored identity a durable Run recorded when it was minted. */
export interface PinnedDefinitionRef {
  readonly businessId: string;
  readonly bundleDigest: string;
  readonly kind: PinnedArtifactKind;
  readonly definitionId: string;
  readonly authoredVersion: number;
}

export class PinnedDefinitionTemporalClassError extends BundleError {
  readonly artifactKind: string;
  readonly temporalClass: "pinned" | "live" | null;

  constructor(kind: string, temporalClass: "pinned" | "live" | null) {
    super(
      "INVALID_DEFINITION",
      `Pinned definition loader refuses ${temporalClass ?? "unknown"} artifact kind ${kind}`,
      { subject: kind }
    );
    this.name = "PinnedDefinitionTemporalClassError";
    this.artifactKind = kind;
    this.temporalClass = temporalClass;
  }
}

export class LiveAuthorityTemporalClassError extends BundleError {
  readonly artifactKind: string;
  readonly temporalClass: "pinned" | "live" | null;

  constructor(kind: string, temporalClass: "pinned" | "live" | null) {
    super(
      "INVALID_DEFINITION",
      `Live authority reader refuses ${temporalClass ?? "unknown"} artifact kind ${kind}`,
      { subject: kind }
    );
    this.name = "LiveAuthorityTemporalClassError";
    this.artifactKind = kind;
    this.temporalClass = temporalClass;
  }
}

/** A definition opened only after its immutable bundle and signature were verified. */
export interface PinnedDefinition {
  readonly bundle: RuntimeBundle;
  readonly definition: BundleDefinition;
}

/** Exact authority identity a future live reader must open from the current active version only. */
export interface LiveAuthorityDefinitionRef {
  readonly businessId: string;
  readonly kind: LiveArtifactKind;
  readonly definitionId: string;
}

export interface LiveAuthorityDefinitionReader {
  loadCurrent(ref: LiveAuthorityDefinitionRef): Promise<BundleDefinition | undefined>;
}

export function assertPinnedDefinitionKind(kind: string): asserts kind is PinnedArtifactKind {
  const temporalClass = temporalClassOf(kind);
  if (temporalClass !== "pinned") throw new PinnedDefinitionTemporalClassError(kind, temporalClass);
}

export function assertLiveAuthorityKind(kind: string): asserts kind is LiveArtifactKind {
  const temporalClass = temporalClassOf(kind);
  if (temporalClass !== "live") throw new LiveAuthorityTemporalClassError(kind, temporalClass);
}

/**
 * Git-free exact-definition reader for durable execution.
 *
 * A Run pins all five identity fields above. This loader accepts only a stored bundle whose
 * signature is valid and whose definition matches every pin; it never consults the active alias,
 * so publishing a newer bundle cannot change a Run that is already queued or waiting. That
 * immutability is only safe for behaviour: authority kinds are refused here because revocation must
 * be read live, never from a Run-pinned bundle.
 */
export class PinnedDefinitionLoader {
  constructor(
    private readonly bundles: Pick<BundleStore, "get">,
    private readonly verifier: BundleVerifier
  ) {}

  async load(ref: PinnedDefinitionRef): Promise<PinnedDefinition | undefined> {
    assertPinnedDefinitionKind(ref.kind);

    const record = await this.bundles.get(ref.bundleDigest);
    if (record === undefined) return undefined;

    const bundle = verifyExecutionBundle(record, this.verifier);
    if (bundle.digest !== ref.bundleDigest || bundle.businessId !== ref.businessId)
      return undefined;

    const definition = bundle.getById(ref.definitionId);
    if (
      definition === undefined ||
      definition.kind !== ref.kind ||
      definition.authoredVersion !== ref.authoredVersion
    ) {
      return undefined;
    }

    return { bundle, definition };
  }
}
