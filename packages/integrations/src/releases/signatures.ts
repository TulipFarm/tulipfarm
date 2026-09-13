import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import {
  type OimReleasePackage,
  type VerifiedOimReleasePackage,
  verifyOimReleasePackage,
} from "./package-verifier";

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

export interface VerifiedSignedOimRelease extends VerifiedOimReleasePackage {
  readonly signerKeyId: string;
  readonly signedRelease: SignedOimRelease;
}

export interface VerifiedSignedOimRevocationList extends OimRevocationList {
  readonly signerKeyId: string;
  readonly signedRevocationList: SignedOimRevocationList;
}

export type OimReleaseSignatureErrorCode =
  | "RELEASE_ENVELOPE_INVALID"
  | "RELEASE_IDENTITY_MISMATCH"
  | "RELEASE_SIGNATURE_INVALID"
  | "RELEASE_SIGNER_UNKNOWN"
  | "REVOCATION_ENVELOPE_INVALID"
  | "REVOCATION_SIGNATURE_INVALID"
  | "REVOCATION_SIGNER_UNKNOWN"
  | "SIGNING_KEY_INVALID"
  | "TRUSTED_KEY_INVALID";

export class OimReleaseSignatureError extends Error {
  constructor(
    readonly code: OimReleaseSignatureErrorCode,
    message: string
  ) {
    super(message);
    this.name = "OimReleaseSignatureError";
  }
}

const RELEASE_DOMAIN = "tulipfarm.oim.release.v1";
const REVOCATION_DOMAIN = "tulipfarm.oim.revocations.v1";
const INTEGRATION_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SEMVER_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ED25519_SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{86}==$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function signatureError(code: OimReleaseSignatureErrorCode, message: string): never {
  throw new OimReleaseSignatureError(code, message);
}

function validKeyId(keyId: unknown): keyId is string {
  return typeof keyId === "string" && KEY_ID_PATTERN.test(keyId);
}

function validIntegrationId(integrationId: unknown): integrationId is string {
  return (
    typeof integrationId === "string" &&
    integrationId.length <= 96 &&
    INTEGRATION_ID_PATTERN.test(integrationId)
  );
}

function validVersion(version: unknown): version is string {
  return typeof version === "string" && version.length <= 128 && SEMVER_PATTERN.test(version);
}

function releasePayload(release: SignedOimRelease["release"]): Uint8Array {
  return Buffer.from(
    `${RELEASE_DOMAIN}\n${JSON.stringify({
      integrationId: release.integrationId,
      version: release.version,
      packageDigest: release.packageDigest,
    })}`,
    "utf8"
  );
}

function revocationPayload(list: OimRevocationList): Uint8Array {
  return Buffer.from(
    `${REVOCATION_DOMAIN}\n${JSON.stringify({
      sequence: list.sequence,
      issuedAt: list.issuedAt,
      expiresAt: list.expiresAt,
      revocations: list.revocations.map((revocation) => ({
        integrationId: revocation.integrationId,
        version: revocation.version,
        packageDigest: revocation.packageDigest,
        reason: revocation.reason,
      })),
    })}`,
    "utf8"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isCanonicalEd25519Signature(value: unknown): value is string {
  if (typeof value !== "string" || !ED25519_SIGNATURE_PATTERN.test(value)) return false;
  const bytes = Buffer.from(value, "base64");
  return bytes.length === 64 && bytes.toString("base64") === value;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
}

function releaseIdentityKey(identity: OimRevocation): string {
  return `${identity.integrationId}\n${identity.version}\n${identity.packageDigest}`;
}

function parseRevocation(value: unknown): OimRevocation | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["integrationId", "packageDigest", "reason", "version"]) ||
    !validIntegrationId(value.integrationId) ||
    !validVersion(value.version) ||
    typeof value.packageDigest !== "string" ||
    !SHA256_PATTERN.test(value.packageDigest) ||
    typeof value.reason !== "string" ||
    value.reason.length === 0 ||
    value.reason.length > 1024 ||
    value.reason.includes("\0")
  ) {
    return undefined;
  }
  return Object.freeze({
    integrationId: value.integrationId,
    version: value.version,
    packageDigest: value.packageDigest,
    reason: value.reason,
  });
}

function parseRevocationList(value: unknown): OimRevocationList {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["expiresAt", "issuedAt", "revocations", "sequence"]) ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1 ||
    !isCanonicalTimestamp(value.issuedAt) ||
    !isCanonicalTimestamp(value.expiresAt) ||
    Date.parse(value.issuedAt) >= Date.parse(value.expiresAt) ||
    !Array.isArray(value.revocations)
  ) {
    signatureError("REVOCATION_ENVELOPE_INVALID", "OIM revocation list is malformed");
  }

  const revocations: OimRevocation[] = [];
  const identities = new Set<string>();
  let previousIdentity: string | undefined;
  for (const input of value.revocations) {
    const revocation = parseRevocation(input);
    if (revocation === undefined) {
      signatureError("REVOCATION_ENVELOPE_INVALID", "OIM revocation list is malformed");
    }
    const identityKey = releaseIdentityKey(revocation);
    if (
      identities.has(identityKey) ||
      (previousIdentity !== undefined && identityKey < previousIdentity)
    ) {
      signatureError(
        "REVOCATION_ENVELOPE_INVALID",
        "OIM revocation identities must be unique and canonically ordered"
      );
    }
    identities.add(identityKey);
    previousIdentity = identityKey;
    revocations.push(revocation);
  }

  return Object.freeze({
    sequence: value.sequence as number,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    revocations: Object.freeze(revocations),
  });
}

export function parseSignedOimRelease(value: unknown): SignedOimRelease {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["envelopeVersion", "release", "signature"]) ||
    value.envelopeVersion !== 1 ||
    !isRecord(value.release) ||
    !hasExactKeys(value.release, ["integrationId", "packageDigest", "version"]) ||
    !validIntegrationId(value.release.integrationId) ||
    !validVersion(value.release.version) ||
    typeof value.release.packageDigest !== "string" ||
    !SHA256_PATTERN.test(value.release.packageDigest) ||
    !isRecord(value.signature) ||
    !hasExactKeys(value.signature, ["algorithm", "keyId", "value"]) ||
    value.signature.algorithm !== "Ed25519" ||
    !validKeyId(value.signature.keyId) ||
    !isCanonicalEd25519Signature(value.signature.value)
  ) {
    signatureError("RELEASE_ENVELOPE_INVALID", "OIM release envelope is malformed");
  }

  return Object.freeze({
    envelopeVersion: 1,
    release: Object.freeze({
      integrationId: value.release.integrationId,
      version: value.release.version,
      packageDigest: value.release.packageDigest,
    }),
    signature: Object.freeze({
      algorithm: "Ed25519",
      keyId: value.signature.keyId,
      value: value.signature.value,
    }),
  });
}

export function parseSignedOimRevocationList(value: unknown): SignedOimRevocationList {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["envelopeVersion", "list", "signature"]) ||
    value.envelopeVersion !== 1 ||
    !isRecord(value.signature) ||
    !hasExactKeys(value.signature, ["algorithm", "keyId", "value"]) ||
    value.signature.algorithm !== "Ed25519" ||
    !validKeyId(value.signature.keyId) ||
    !isCanonicalEd25519Signature(value.signature.value)
  ) {
    signatureError("REVOCATION_ENVELOPE_INVALID", "OIM revocation envelope is malformed");
  }
  const list = parseRevocationList(value.list);
  return Object.freeze({
    envelopeVersion: 1,
    list,
    signature: Object.freeze({
      algorithm: "Ed25519",
      keyId: value.signature.keyId,
      value: value.signature.value,
    }),
  });
}

function assertEd25519Key(
  key: KeyObject,
  code: "SIGNING_KEY_INVALID" | "TRUSTED_KEY_INVALID",
  usage: string
): void {
  if (key.asymmetricKeyType !== "ed25519") {
    signatureError(code, `OIM ${usage} requires an Ed25519 key`);
  }
}

export function createEd25519OimReleaseSigner(
  keyId: string,
  privateKeyPem: string
): OimReleaseSigner {
  if (!validKeyId(keyId) || typeof privateKeyPem !== "string" || privateKeyPem.length > 16_384) {
    signatureError("SIGNING_KEY_INVALID", "OIM signer configuration is invalid");
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch {
    signatureError("SIGNING_KEY_INVALID", "OIM signer private key is invalid");
  }
  assertEd25519Key(privateKey, "SIGNING_KEY_INVALID", "signer");

  return Object.freeze({
    keyId,
    sign(payload: Uint8Array): string {
      return cryptoSign(null, payload, privateKey).toString("base64");
    },
  });
}

function trustedPublicKey(trustedKey: TrustedOimPublicKey): KeyObject {
  if (
    !validKeyId(trustedKey.keyId) ||
    typeof trustedKey.publicKeyPem !== "string" ||
    trustedKey.publicKeyPem.length === 0 ||
    trustedKey.publicKeyPem.length > 16_384 ||
    trustedKey.publicKeyPem.includes("PRIVATE KEY")
  ) {
    signatureError("TRUSTED_KEY_INVALID", "OIM trusted release key is invalid");
  }
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(trustedKey.publicKeyPem);
  } catch {
    signatureError("TRUSTED_KEY_INVALID", "OIM trusted release public key is invalid");
  }
  assertEd25519Key(publicKey, "TRUSTED_KEY_INVALID", "release verifier");
  return publicKey;
}

export class OimEd25519Keyring {
  readonly #keys: ReadonlyMap<string, KeyObject>;

  constructor(trustedKeys: readonly TrustedOimPublicKey[]) {
    const keys = new Map<string, KeyObject>();
    for (const trustedKey of trustedKeys) {
      if (keys.has(trustedKey.keyId)) {
        signatureError(
          "TRUSTED_KEY_INVALID",
          `Duplicate OIM trusted release key id ${trustedKey.keyId}`
        );
      }
      keys.set(trustedKey.keyId, trustedPublicKey(trustedKey));
    }
    this.#keys = keys;
  }

  has(keyId: string): boolean {
    return this.#keys.has(keyId);
  }

  verifyRelease(envelope: SignedOimRelease): boolean {
    const key = this.#keys.get(envelope.signature.keyId);
    if (key === undefined) return false;
    try {
      return cryptoVerify(
        null,
        releasePayload(envelope.release),
        key,
        Buffer.from(envelope.signature.value, "base64")
      );
    } catch {
      return false;
    }
  }

  verifyRevocationList(envelope: SignedOimRevocationList): boolean {
    const key = this.#keys.get(envelope.signature.keyId);
    if (key === undefined) return false;
    try {
      return cryptoVerify(
        null,
        revocationPayload(envelope.list),
        key,
        Buffer.from(envelope.signature.value, "base64")
      );
    } catch {
      return false;
    }
  }
}

export function signOimRelease(
  packageInput: OimReleasePackage,
  signer: OimReleaseSigner
): SignedOimRelease {
  const verifiedPackage = verifyOimReleasePackage(packageInput);
  if (!validKeyId(signer.keyId)) {
    signatureError("SIGNING_KEY_INVALID", "OIM signer key id is invalid");
  }
  const release = Object.freeze({
    integrationId: verifiedPackage.integrationId,
    version: verifiedPackage.version,
    packageDigest: verifiedPackage.packageDigest,
  });
  const signatureValue = signer.sign(releasePayload(release));
  if (!isCanonicalEd25519Signature(signatureValue)) {
    signatureError("SIGNING_KEY_INVALID", "OIM signer returned an invalid Ed25519 signature");
  }
  return Object.freeze({
    envelopeVersion: 1,
    release,
    signature: Object.freeze({
      algorithm: "Ed25519",
      keyId: signer.keyId,
      value: signatureValue,
    }),
  });
}

export function verifySignedOimRelease(
  packageInput: OimReleasePackage,
  signedReleaseInput: unknown,
  trustedKeys: readonly TrustedOimPublicKey[]
): VerifiedSignedOimRelease {
  const verifiedPackage = verifyOimReleasePackage(packageInput);
  const signedRelease = parseSignedOimRelease(signedReleaseInput);
  const keyring = new OimEd25519Keyring(trustedKeys);
  if (!keyring.has(signedRelease.signature.keyId)) {
    signatureError(
      "RELEASE_SIGNER_UNKNOWN",
      `OIM release signer ${signedRelease.signature.keyId} is not trusted`
    );
  }
  if (!keyring.verifyRelease(signedRelease)) {
    signatureError("RELEASE_SIGNATURE_INVALID", "OIM release signature is invalid");
  }
  if (
    signedRelease.release.integrationId !== verifiedPackage.integrationId ||
    signedRelease.release.version !== verifiedPackage.version ||
    signedRelease.release.packageDigest !== verifiedPackage.packageDigest
  ) {
    signatureError(
      "RELEASE_IDENTITY_MISMATCH",
      "OIM release signature does not bind the supplied package"
    );
  }

  return Object.freeze({
    ...verifiedPackage,
    signerKeyId: signedRelease.signature.keyId,
    signedRelease,
  });
}

export function signOimRevocationList(
  listInput: OimRevocationList,
  signer: OimReleaseSigner
): SignedOimRevocationList {
  if (!validKeyId(signer.keyId)) {
    signatureError("SIGNING_KEY_INVALID", "OIM signer key id is invalid");
  }
  if (!isRecord(listInput)) {
    signatureError("REVOCATION_ENVELOPE_INVALID", "OIM revocation list is malformed");
  }
  const revocationsInput = Array.isArray(listInput.revocations)
    ? [...listInput.revocations].sort((left, right) =>
        releaseIdentityKey(left) < releaseIdentityKey(right)
          ? -1
          : releaseIdentityKey(left) > releaseIdentityKey(right)
            ? 1
            : 0
      )
    : listInput.revocations;
  const list = parseRevocationList({ ...listInput, revocations: revocationsInput });
  const signatureValue = signer.sign(revocationPayload(list));
  if (!isCanonicalEd25519Signature(signatureValue)) {
    signatureError("SIGNING_KEY_INVALID", "OIM signer returned an invalid Ed25519 signature");
  }
  return Object.freeze({
    envelopeVersion: 1,
    list,
    signature: Object.freeze({
      algorithm: "Ed25519",
      keyId: signer.keyId,
      value: signatureValue,
    }),
  });
}

export function verifySignedOimRevocationList(
  signedRevocationListInput: unknown,
  trustedKeys: readonly TrustedOimPublicKey[]
): VerifiedSignedOimRevocationList {
  const signedRevocationList = parseSignedOimRevocationList(signedRevocationListInput);
  const keyring = new OimEd25519Keyring(trustedKeys);
  if (!keyring.has(signedRevocationList.signature.keyId)) {
    signatureError(
      "REVOCATION_SIGNER_UNKNOWN",
      `OIM revocation signer ${signedRevocationList.signature.keyId} is not trusted`
    );
  }
  if (!keyring.verifyRevocationList(signedRevocationList)) {
    signatureError("REVOCATION_SIGNATURE_INVALID", "OIM revocation signature is invalid");
  }
  return Object.freeze({
    ...signedRevocationList.list,
    signerKeyId: signedRevocationList.signature.keyId,
    signedRevocationList,
  });
}

export function validateTrustedOimPublicKey(key: TrustedOimPublicKey): void {
  new OimEd25519Keyring([key]);
}
