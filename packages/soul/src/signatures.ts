import { createPrivateKey, createPublicKey, type KeyObject, sign, verify } from "node:crypto";
import {
  BundleError,
  type BundleSignature,
  type BundleVerifier,
  computeBundleDigest,
  createRuntimeBundle,
  EXECUTION_BUNDLE_VERSION,
  type ExecutionBundle,
  type RuntimeBundle,
  type SignedExecutionBundle,
} from "./bundle";

/** Encrypted Secret holding the Ed25519 private key used only by the API publisher. */
export const SOUL_BUNDLE_PRIVATE_KEY = "soul-bundle.ed25519.private-key";

/** Encrypted Secret holding the Ed25519 public key used by runtime verifiers. */
export const SOUL_BUNDLE_PUBLIC_KEY = "soul-bundle.ed25519.public-key";

/** Stable public key identity recorded beside every signed execution bundle. */
export const SOUL_BUNDLE_SIGNING_KEY_ID = "soul-bundle-v1";

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

export type { BundleVerifier };

export interface TrustedBundlePublicKey {
  readonly keyId: string;
  readonly publicKeyPem: string;
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

const verifierAdapters = new WeakMap<BundleSigner, BundleVerifier>();

function assertEd25519Key(key: KeyObject, usage: "signer" | "verifier"): void {
  if (key.asymmetricKeyType !== "ed25519") {
    throw new BundleError("SIGNATURE_INVALID", `Ed25519 bundle ${usage} requires an Ed25519 key`);
  }
}

function payloadBytes(payload: string): Buffer {
  return Buffer.from(payload, "utf8");
}

function signatureBytes(signature: string): Buffer {
  return Buffer.from(signature, "base64");
}

function parsePrivateKey(privateKeyPem: string): KeyObject {
  if (privateKeyPem.length === 0) {
    throw new BundleError(
      "SIGNATURE_INVALID",
      "Ed25519 bundle signer requires a non-empty private key"
    );
  }
  const privateKey = createPrivateKey(privateKeyPem);
  assertEd25519Key(privateKey, "signer");
  return privateKey;
}

function parsePublicKey(publicKeyPem: string): KeyObject {
  if (publicKeyPem.length === 0) {
    throw new BundleError(
      "SIGNATURE_INVALID",
      "Ed25519 bundle verifier requires a non-empty public key"
    );
  }
  const publicKey = createPublicKey(publicKeyPem);
  assertEd25519Key(publicKey, "verifier");
  return publicKey;
}

/** Ed25519 signer over the canonical bundle payload, backed by a PKCS8 private key PEM. */
export function createEd25519BundleSigner(keyId: string, privateKeyPem: string): BundleSigner {
  if (keyId.length === 0) {
    throw new BundleError("SIGNATURE_INVALID", "Ed25519 bundle signer requires a non-empty keyId");
  }
  const privateKey = parsePrivateKey(privateKeyPem);
  const publicKeyPem = createPublicKey(privateKeyPem)
    .export({
      format: "pem",
      type: "spki",
    })
    .toString();
  const signer: BundleSigner = Object.freeze({
    keyId,
    sign(payload: string): string {
      return sign(null, payloadBytes(payload), privateKey).toString("base64");
    },
  });
  verifierAdapters.set(signer, createEd25519BundleVerifier([{ keyId, publicKeyPem }]));
  return signer;
}

/**
 * Ed25519 verifier over one or more trusted SPKI public key PEMs. Key selection is by the keyId
 * recorded beside the bundle, so old public keys can stay trusted after publication rotates to a
 * new private key.
 */
export function createEd25519BundleVerifier(
  trustedKeys: readonly TrustedBundlePublicKey[]
): BundleVerifier {
  if (trustedKeys.length === 0) {
    throw new BundleError(
      "SIGNATURE_INVALID",
      "Ed25519 bundle verifier requires at least one trusted public key"
    );
  }
  const keys = new Map<string, KeyObject>();
  for (const trustedKey of trustedKeys) {
    if (trustedKey.keyId.length === 0) {
      throw new BundleError(
        "SIGNATURE_INVALID",
        "Ed25519 bundle verifier requires non-empty keyIds"
      );
    }
    if (keys.has(trustedKey.keyId)) {
      throw new BundleError(
        "SIGNATURE_INVALID",
        `Ed25519 bundle verifier has duplicate keyId ${trustedKey.keyId}`
      );
    }
    keys.set(trustedKey.keyId, parsePublicKey(trustedKey.publicKeyPem));
  }
  const trustedKeyIds = Object.freeze([...keys.keys()]);
  return Object.freeze({
    trustedKeyIds,
    verify(payload: string, signature: BundleSignature): boolean {
      const publicKey = keys.get(signature.keyId);
      if (publicKey === undefined) return false;
      try {
        return verify(null, payloadBytes(payload), publicKey, signatureBytes(signature.value));
      } catch {
        return false;
      }
    },
  });
}

/**
 * Transitional adapter for tests and old call sites that already own a signer created here. It
 * never manufactures HMAC verification; callers that need runtime verification must provision
 * Ed25519 public keys.
 */
export function verifierFromSigner(signer: BundleSigner): BundleVerifier {
  const verifier = verifierAdapters.get(signer);
  if (verifier === undefined) {
    throw new BundleError(
      "SIGNATURE_INVALID",
      "Bundle signer does not expose a public-key verifier"
    );
  }
  return verifier;
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

/**
 * Verify a stored bundle and open it for execution. Fails closed: the digest is recomputed from
 * the bundle's own data (tamper detection) before the public-key signature is checked, and only a
 * fully verified bundle yields a {@link RuntimeBundle}. No Git access is involved.
 */
export function verifyExecutionBundle(
  record: SignedExecutionBundle,
  verifier: BundleVerifier
): RuntimeBundle {
  if (record.bundle.bundleVersion !== EXECUTION_BUNDLE_VERSION) {
    throw new BundleError(
      "BUNDLE_VERSION_UNSUPPORTED",
      `Execution bundle version ${record.bundle.bundleVersion} is not supported`
    );
  }
  const digest = computeBundleDigest(record.bundle);
  if (digest !== record.digest) {
    throw new BundleError("DIGEST_MISMATCH", "Execution bundle content does not match its digest");
  }
  if (!verifier.trustedKeyIds.includes(record.signature.keyId)) {
    throw new BundleError(
      "SIGNATURE_KEY_UNKNOWN",
      `Execution bundle signature keyId ${record.signature.keyId} is not trusted`
    );
  }
  if (!verifier.verify(buildBundleSigningPayload(record.bundle, digest), record.signature)) {
    throw new BundleError("SIGNATURE_INVALID", "Execution bundle signature is not valid");
  }
  return createRuntimeBundle(record.bundle, digest);
}
