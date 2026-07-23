import { createHmac, timingSafeEqual } from "node:crypto";
import {
  BundleError,
  type BundleSignature,
  computeBundleDigest,
  createRuntimeBundle,
  type ExecutionBundle,
  type RuntimeBundle,
  type SignedExecutionBundle,
} from "./bundle";

/**
 * Bundle signing and tamper verification (SPEC §8.2 step 9).
 *
 * The signature covers the bundle's content address plus its identity, so any edit to a definition
 * changes the digest and any edit to the identity or the signature fails verification. Key
 * material never enters this package: the caller injects a signer bound to an authorized key.
 */

export interface BundleSigner {
  readonly keyId: string;
  sign(payload: string): string;
}

/**
 * Canonical bytes the bundle signature covers. The digest already covers every definition, so the
 * payload binds it to the bundle identity and version.
 */
export function buildBundleSigningPayload(bundle: ExecutionBundle, digest: string): string {
  return JSON.stringify({
    bundleVersion: bundle.bundleVersion,
    digest,
    business: bundle.businessId,
    changeset: bundle.changesetId,
    commit: bundle.commitSha,
  });
}

/** HMAC-SHA256 signer over the canonical bundle payload. */
export function createHmacBundleSigner(keyId: string, secret: string): BundleSigner {
  if (keyId.length === 0 || secret.length === 0) {
    throw new BundleError(
      "SIGNATURE_INVALID",
      "HMAC bundle signer requires a non-empty keyId and secret"
    );
  }
  return {
    keyId,
    sign(payload: string): string {
      return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
    },
  };
}

/** Hash and sign a compiled bundle. The result is the storable, content-addressed record. */
export function signExecutionBundle(
  bundle: ExecutionBundle,
  signer: BundleSigner
): SignedExecutionBundle {
  const digest = computeBundleDigest(bundle);
  const signature: BundleSignature = {
    keyId: signer.keyId,
    value: signer.sign(buildBundleSigningPayload(bundle, digest)),
  };
  return Object.freeze({ bundle, digest, signature: Object.freeze(signature) });
}

function signatureMatches(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(actual, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Verify a stored bundle and open it for execution. Fails closed: the digest is recomputed from
 * the bundle's own data (tamper detection) before the signature is checked in constant time, and
 * only a fully verified bundle yields a {@link RuntimeBundle}. No Git access is involved.
 */
export function verifyExecutionBundle(
  record: SignedExecutionBundle,
  signer: BundleSigner
): RuntimeBundle {
  const digest = computeBundleDigest(record.bundle);
  if (digest !== record.digest) {
    throw new BundleError("DIGEST_MISMATCH", "Execution bundle content does not match its digest");
  }
  const expected = signer.sign(buildBundleSigningPayload(record.bundle, digest));
  if (
    record.signature.keyId !== signer.keyId ||
    !signatureMatches(expected, record.signature.value)
  ) {
    throw new BundleError("SIGNATURE_INVALID", "Execution bundle signature is not valid");
  }
  return createRuntimeBundle(record.bundle, digest);
}
