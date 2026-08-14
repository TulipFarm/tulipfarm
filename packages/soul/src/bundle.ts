import { canonicalHash, type VersionedSchemaDocument } from "@tulipfarm/schema";

/** Immutable, content-addressed runtime bundle: validated definitions only, no Git or secrets. */

export const EXECUTION_BUNDLE_VERSION = 2 as const;

export type BundleErrorCode =
  | "INVALID_DEFINITION"
  | "UNRESOLVED_REF"
  | "VERSION_UNSATISFIED"
  | "SECRET_MATERIAL"
  | "DIGEST_MISMATCH"
  | "SIGNATURE_INVALID"
  | "SIGNATURE_KEY_UNKNOWN"
  | "BUNDLE_VERSION_UNSUPPORTED";

export interface BundleAsset {
  readonly ownerDefinitionId: string;
  /** Path relative to the owning Skill directory. */
  readonly path: string;
  /** SHA-256 of the exact UTF-8 bytes. */
  readonly digest: string;
  readonly content: string;
}

/**
 * Deterministic, payload-safe bundle failure. Carries only authored identifiers and JSON pointers
 * — never definition content, credential material, or user data.
 */
export class BundleError extends Error {
  readonly code: BundleErrorCode;
  /** The owning definition as `Kind:slug`, when the failure has one. */
  readonly subject?: string;
  /** JSON pointer into the owning definition's document. */
  readonly field?: string;

  constructor(
    code: BundleErrorCode,
    message: string,
    details: { subject?: string; field?: string } = {}
  ) {
    super(message);
    this.name = "BundleError";
    this.code = code;
    if (details.subject !== undefined) this.subject = details.subject;
    if (details.field !== undefined) this.field = details.field;
  }
}

/** One authored reference, pinned to the exact definition version the bundle compiled. */
export interface ResolvedReference {
  /** JSON pointer of the reference inside the owning definition. */
  readonly field: string;
  readonly kind: string;
  readonly id: string;
  readonly slug: string;
  readonly authoredVersion: number;
}

export interface BundleDefinition {
  readonly kind: string;
  readonly id: string;
  readonly slug: string;
  readonly authoredVersion: number;
  /** Canonical hash of the authored document (identity, independent of YAML formatting). */
  readonly hash: string;
  readonly document: VersionedSchemaDocument;
  readonly references: readonly ResolvedReference[];
}

export interface ExecutionBundle {
  readonly bundleVersion: typeof EXECUTION_BUNDLE_VERSION;
  readonly businessId: string;
  readonly changesetId: string;
  /** Commit lineage is signed but excluded from the content digest so identical bundles dedupe. */
  readonly commitSha: string;
  /** Sorted by `kind` then `slug`, so the digest is order-independent. */
  readonly definitions: readonly BundleDefinition[];
  /** Sorted immutable companion files required by published Skill commands. */
  readonly assets: readonly BundleAsset[];
}

export interface BundleSignature {
  readonly keyId: string;
  readonly value: string;
}

export interface BundleVerifier {
  readonly trustedKeyIds: readonly string[];
  verify(payload: string, signature: BundleSignature): boolean;
}

/** A bundle plus its content address and the signature covering it. */
export interface SignedExecutionBundle {
  readonly bundle: ExecutionBundle;
  readonly digest: string;
  readonly signature: BundleSignature;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/** Takes a detached, deeply immutable snapshot at an append-only boundary. */
export function immutableSnapshot<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

/** Content address of a bundle: the canonical hash of its authored content, not its lineage. */
export function computeBundleDigest(bundle: ExecutionBundle): string {
  return canonicalHash({
    bundleVersion: bundle.bundleVersion,
    businessId: bundle.businessId,
    definitions: bundle.definitions,
    assets: bundle.assets,
  });
}

/** The verified, Git-free view a worker executes against. */
export interface RuntimeBundle {
  readonly digest: string;
  readonly businessId: string;
  readonly changesetId: string;
  readonly commitSha: string;
  readonly definitions: readonly BundleDefinition[];
  readonly assets: readonly BundleAsset[];
  get(kind: string, slug: string): BundleDefinition | undefined;
  getById(id: string): BundleDefinition | undefined;
  asset(ownerDefinitionId: string, path: string): BundleAsset | undefined;
}

/**
 * Build the runtime view. Internal on purpose: {@link import("./signatures").verifyExecutionBundle}
 * is the only public way to open a bundle, so execution can never skip verification.
 */
export function createRuntimeBundle(bundle: ExecutionBundle, digest: string): RuntimeBundle {
  const snapshot = immutableSnapshot(bundle);
  const byId = new Map(snapshot.definitions.map((d) => [d.id, d]));
  const byKindSlug = new Map(snapshot.definitions.map((d) => [`${d.kind} ${d.slug}`, d]));
  const byAsset = new Map(
    snapshot.assets.map((asset) => [`${asset.ownerDefinitionId}\u0000${asset.path}`, asset])
  );
  return Object.freeze({
    digest,
    businessId: snapshot.businessId,
    changesetId: snapshot.changesetId,
    commitSha: snapshot.commitSha,
    definitions: snapshot.definitions,
    assets: snapshot.assets,
    get: (kind: string, slug: string) => byKindSlug.get(`${kind} ${slug}`),
    getById: (id: string) => byId.get(id),
    asset: (ownerDefinitionId: string, path: string) =>
      byAsset.get(`${ownerDefinitionId}\u0000${path}`),
  });
}

/** Append-only bundle storage: the first stored copy for a digest is authoritative. */
export interface BundleStore {
  put(record: SignedExecutionBundle): Promise<void>;
  get(digest: string): Promise<SignedExecutionBundle | undefined>;
}

/** Process-local store. Durable backends implement the same {@link BundleStore} contract. */
export class InMemoryBundleStore implements BundleStore {
  private readonly records = new Map<string, SignedExecutionBundle>();

  async put(record: SignedExecutionBundle): Promise<void> {
    const digest = computeBundleDigest(record.bundle);
    if (digest !== record.digest) {
      throw new BundleError(
        "DIGEST_MISMATCH",
        "Bundle store: record digest does not cover its bundle"
      );
    }
    // First stored copy wins: a same-digest republish under a new signature is legitimate content
    // addressing, so accept it idempotently without overwriting the authoritative attestation.
    if (this.records.has(digest)) return;
    this.records.set(digest, immutableSnapshot(record));
  }

  async get(digest: string): Promise<SignedExecutionBundle | undefined> {
    return this.records.get(digest);
  }
}
