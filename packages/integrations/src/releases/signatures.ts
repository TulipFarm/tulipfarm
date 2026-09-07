import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import {
  type OimManifest,
  type OimPackageContent,
  oimPackageDigest,
  oimPackageIssues,
} from "@tulipfarm/schema";

export interface OimReleasePackage {
  readonly manifest: OimManifest;
  readonly files: ReadonlyMap<string, OimPackageContent>;
}

export interface OimSignature {
  readonly algorithm: "Ed25519";
  readonly keyId: string;
  readonly value: string;
}

export interface SignedOimRelease {
  readonly envelopeVersion: 1;
  readonly release: {
    readonly integrationId: string;
    readonly version: string;
    readonly packageDigest: string;
  };
  readonly signature: OimSignature;
}

export interface OimRevocation {
  readonly integrationId: string;
  readonly version: string;
  readonly packageDigest: string;
  readonly reason: string;
}

export interface OimRevocationList {
  readonly sequence: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revocations: readonly OimRevocation[];
}

export interface SignedOimRevocationList {
  readonly envelopeVersion: 1;
  readonly list: OimRevocationList;
  readonly signature: OimSignature;
}

export interface OimReleaseSigner {
  readonly keyId: string;
  sign(payload: Uint8Array): string;
}

export interface TrustedOimPublicKey {
  readonly keyId: string;
  readonly publicKeyPem: string;
}

const RELEASE_DOMAIN = "tulipfarm.oim.release.v1";
const REVOCATION_DOMAIN = "tulipfarm.oim.revocations.v1";

function payloadBytes(domain: string, value: unknown): Uint8Array {
  return Buffer.from(`${domain}\n${JSON.stringify(value)}`, "utf8");
}

function releasePayload(release: SignedOimRelease["release"]): Uint8Array {
  return payloadBytes(RELEASE_DOMAIN, {
    integrationId: release.integrationId,
    version: release.version,
    packageDigest: release.packageDigest,
  });
}

function revocationPayload(list: OimRevocationList): Uint8Array {
  return payloadBytes(REVOCATION_DOMAIN, {
    sequence: list.sequence,
    issuedAt: list.issuedAt,
    expiresAt: list.expiresAt,
    revocations: list.revocations.map((revocation) => ({
      integrationId: revocation.integrationId,
      version: revocation.version,
      packageDigest: revocation.packageDigest,
      reason: revocation.reason,
    })),
  });
}

function assertEd25519Key(key: KeyObject, usage: string): void {
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`OIM ${usage} requires an Ed25519 key`);
  }
}

export function createEd25519OimReleaseSigner(
  keyId: string,
  privateKeyPem: string
): OimReleaseSigner {
  if (keyId.length === 0) throw new Error("OIM signer requires a non-empty keyId");
  const privateKey = createPrivateKey(privateKeyPem);
  assertEd25519Key(privateKey, "signer");
  return Object.freeze({
    keyId,
    sign(payload: Uint8Array): string {
      return cryptoSign(null, payload, privateKey).toString("base64");
    },
  });
}

export function signOimRelease(
  packageInput: OimReleasePackage,
  signer: OimReleaseSigner
): SignedOimRelease {
  const issues = oimPackageIssues(packageInput.manifest, packageInput.files);
  if (issues.length > 0) {
    throw new Error(`Cannot sign invalid OIM package: ${issues.join("; ")}`);
  }
  const release = {
    integrationId: packageInput.manifest.metadata.id,
    version: packageInput.manifest.metadata.version,
    packageDigest: oimPackageDigest(packageInput.manifest),
  };
  return Object.freeze({
    envelopeVersion: 1,
    release: Object.freeze(release),
    signature: Object.freeze({
      algorithm: "Ed25519",
      keyId: signer.keyId,
      value: signer.sign(releasePayload(release)),
    }),
  });
}

export function signOimRevocationList(
  list: OimRevocationList,
  signer: OimReleaseSigner
): SignedOimRevocationList {
  return Object.freeze({
    envelopeVersion: 1,
    list: Object.freeze({
      ...list,
      revocations: Object.freeze(list.revocations.map((revocation) => Object.freeze(revocation))),
    }),
    signature: Object.freeze({
      algorithm: "Ed25519",
      keyId: signer.keyId,
      value: signer.sign(revocationPayload(list)),
    }),
  });
}

export class OimEd25519Keyring {
  readonly #keys: ReadonlyMap<string, KeyObject>;

  constructor(trustedKeys: readonly TrustedOimPublicKey[]) {
    const keys = new Map<string, KeyObject>();
    for (const trustedKey of trustedKeys) {
      if (trustedKey.keyId.length === 0) throw new Error("OIM trusted keyId must not be empty");
      if (keys.has(trustedKey.keyId)) {
        throw new Error(`Duplicate OIM trusted keyId ${trustedKey.keyId}`);
      }
      const publicKey = createPublicKey(trustedKey.publicKeyPem);
      assertEd25519Key(publicKey, "verifier");
      keys.set(trustedKey.keyId, publicKey);
    }
    this.#keys = keys;
  }

  has(keyId: string): boolean {
    return this.#keys.has(keyId);
  }

  verifyRelease(envelope: SignedOimRelease): boolean {
    return this.#verify(envelope.signature, releasePayload(envelope.release));
  }

  verifyRevocationList(envelope: SignedOimRevocationList): boolean {
    return this.#verify(envelope.signature, revocationPayload(envelope.list));
  }

  #verify(signature: OimSignature, payload: Uint8Array): boolean {
    if (signature.algorithm !== "Ed25519") return false;
    const key = this.#keys.get(signature.keyId);
    if (key === undefined) return false;
    try {
      return cryptoVerify(null, payload, key, Buffer.from(signature.value, "base64"));
    } catch {
      return false;
    }
  }
}

export function validateTrustedOimPublicKey(key: TrustedOimPublicKey): void {
  new OimEd25519Keyring([key]);
}
