import { canonicalHash, type VersionedSchemaDocument } from "@tulipfarm/schema";

/**
 * Immutable execution bundle contract (SPEC §8.2 steps 9 and 14).
 *
 * A bundle is the content-addressed, exact-version snapshot a Run pins its behaviour to. It holds
 * only authored definitions that already passed strict AJV and semantic validation, every
 * reference resolved to a concrete `{id, slug, authoredVersion}`, and never any secret value —
 * Soul carries opaque secret references only, and the compiler enforces that (AW-014).
 *
 * The bundle is deliberately free of Git: a worker loads it from the store by digest, verifies the
 * signature, and executes. No live repository, checkout, or network fetch is involved.
 */

export const EXECUTION_BUNDLE_VERSION = 1 as const;

export type BundleErrorCode =
  | "INVALID_DEFINITION"
  | "UNRESOLVED_REF"
  | "VERSION_UNSATISFIED"
  | "SECRET_MATERIAL"
  | "DIGEST_MISMATCH"
  | "SIGNATURE_INVALID"
  | "DIGEST_CONFLICT";

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
  /** The signed Soul commit this bundle was compiled from, for lineage only. */
  readonly commitSha: string;
  /** Sorted by `kind` then `slug`, so the digest is order-independent. */
  readonly definitions: readonly BundleDefinition[];
}

export interface BundleSignature {
  readonly keyId: string;
  readonly value: string;
}

/** A bundle plus its content address and the signature covering it. */
export interface SignedExecutionBundle {
  readonly bundle: ExecutionBundle;
  readonly digest: string;
  readonly signature: BundleSignature;
}

/** Content address of a bundle: the canonical hash of its complete parsed data. */
export function computeBundleDigest(bundle: ExecutionBundle): string {
  return canonicalHash(bundle);
}

/** The verified, Git-free view a worker executes against. */
export interface RuntimeBundle {
  readonly digest: string;
  readonly businessId: string;
  readonly changesetId: string;
  readonly commitSha: string;
  readonly definitions: readonly BundleDefinition[];
  get(kind: string, slug: string): BundleDefinition | undefined;
  getById(id: string): BundleDefinition | undefined;
}

/**
 * Build the runtime view. Internal on purpose: {@link import("./signatures").verifyExecutionBundle}
 * is the only public way to open a bundle, so execution can never skip verification.
 */
export function createRuntimeBundle(bundle: ExecutionBundle, digest: string): RuntimeBundle {
  const byId = new Map(bundle.definitions.map((d) => [d.id, d]));
  const byKindSlug = new Map(bundle.definitions.map((d) => [`${d.kind} ${d.slug}`, d]));
  return Object.freeze({
    digest,
    businessId: bundle.businessId,
    changesetId: bundle.changesetId,
    commitSha: bundle.commitSha,
    definitions: bundle.definitions,
    get: (kind: string, slug: string) => byKindSlug.get(`${kind} ${slug}`),
    getById: (id: string) => byId.get(id),
  });
}

/**
 * Content-addressed, append-only bundle storage. `put` is idempotent for a duplicate delivery of
 * the same record and never overwrites a stored digest — a bundle is immutable once stored.
 */
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
    const stored = this.records.get(digest);
    if (stored) {
      if (
        stored.signature.keyId !== record.signature.keyId ||
        stored.signature.value !== record.signature.value
      ) {
        throw new BundleError(
          "DIGEST_CONFLICT",
          `Bundle store: digest ${digest} is already stored with a different signature`
        );
      }
      return;
    }
    this.records.set(digest, record);
  }

  async get(digest: string): Promise<SignedExecutionBundle | undefined> {
    return this.records.get(digest);
  }
}
