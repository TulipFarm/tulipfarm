import { type OimManifest, oimCompatibilityIssues, oimPackageDigest } from "@tulipfarm/schema";
import type { InstalledOimReleaseProvenance } from "@tulipfarm/storage";
import {
  type OimReleaseCandidate,
  type OimReleaseSelection,
  verifySelectedOimReleaseCandidate,
} from "./candidates";
import {
  type OimReleasePackage,
  type VerifiedOimReleasePackage,
  verifyOimReleasePackage,
} from "./package-verifier";
import {
  OimEd25519Keyring,
  parseSignedOimRelease,
  type SignedOimRevocationList,
  type TrustedOimPublicKey,
  type VerifiedSignedOimRelease,
  type VerifiedSignedOimRevocationList,
  verifySignedOimRelease,
  verifySignedOimRevocationList,
} from "./signatures";

export interface OimRevocationStateStore {
  load(): Promise<unknown>;
  compareAndSwap(expectedSequence: number | undefined, next: unknown): Promise<boolean>;
}

export interface OimKnownSignedReleaseStore {
  isKnownSignedRelease(identity: {
    readonly integrationId: string;
    readonly version: string;
    readonly packageDigest: string;
  }): Promise<boolean>;
  recordKnownSignedRelease(identity: {
    readonly integrationId: string;
    readonly version: string;
    readonly packageDigest: string;
    readonly keyId: string;
  }): Promise<void>;
}

export interface OimReleaseTrustServiceOptions {
  readonly trustedReleaseKeys: readonly TrustedOimPublicKey[];
  readonly trustedRevocationKeys: readonly TrustedOimPublicKey[];
  readonly revocationStore: OimRevocationStateStore;
  readonly knownSignedReleaseStore: OimKnownSignedReleaseStore;
  readonly now?: () => Date;
  readonly maxRevocationUpdateAttempts?: number;
}

export interface AuthorizeOfficialOimReleaseInput {
  readonly package: OimReleasePackage;
  readonly signedRelease: unknown;
}

export interface AuthorizeSelectedOfficialOimReleaseInput {
  readonly selection: OimReleaseSelection;
  readonly candidates: readonly OimReleaseCandidate[];
}

export interface AuthorizeCommunityOimReleaseInput {
  readonly package: OimReleasePackage;
  readonly approvedPackageDigest: string;
  readonly autoPatchOptIn?: boolean;
}

export interface AuthorizeInstalledOimReleaseInput {
  readonly package: OimReleasePackage;
  readonly provenance: InstalledOimReleaseProvenance;
}

export interface SelectOimAutoPatchInput {
  readonly provenance: InstalledOimReleaseProvenance;
  readonly originalManifest: OimManifest;
  readonly currentPackage: OimReleasePackage;
  readonly selection: OimReleaseSelection;
  readonly candidates: readonly OimReleaseCandidate[];
}

export interface AuthorizedOfficialOimRelease extends VerifiedSignedOimRelease {
  readonly trustClass: "official";
}

export interface AuthorizedCommunityOimRelease extends VerifiedOimReleasePackage {
  readonly trustClass: "community";
  readonly approvedCommunityDigest: string;
}

export interface AuthorizedOimAutoPatch extends AuthorizedOfficialOimRelease {
  readonly package: OimReleasePackage;
}

export type AuthorizedOimRelease = AuthorizedOfficialOimRelease | AuthorizedCommunityOimRelease;

const authorizedReleases = new WeakSet<object>();

export function assertAuthorizedOimRelease(authorization: AuthorizedOimRelease): void {
  if (!authorizedReleases.has(authorization)) {
    trustError(
      "PROVENANCE_MISMATCH",
      "OIM release authorization was not issued by the trust service"
    );
  }
}

export type OimReleaseTrustErrorCode =
  | "COMMUNITY_AUTO_PATCH_FORBIDDEN"
  | "COMMUNITY_DIGEST_REQUIRED"
  | "COMMUNITY_HOOKS_FORBIDDEN"
  | "COMMUNITY_OFFICIAL_RELEASE"
  | "OFFICIAL_RELEASE_REVOKED"
  | "PROVENANCE_MISSING"
  | "PROVENANCE_MISMATCH"
  | "REVOCATION_CAS_EXHAUSTED"
  | "REVOCATION_EXPIRED"
  | "REVOCATION_MISSING"
  | "REVOCATION_NOT_CURRENT"
  | "REVOCATION_REMOVAL"
  | "REVOCATION_REPLAY"
  | "REVOCATION_ROLLBACK"
  | "REVOCATION_STALE"
  | "AUTO_PATCH_INCOMPATIBLE"
  | "AUTO_PATCH_NOT_ALLOWED";

export class OimReleaseTrustError extends Error {
  constructor(
    readonly code: OimReleaseTrustErrorCode,
    message: string
  ) {
    super(message);
    this.name = "OimReleaseTrustError";
  }
}

function trustError(code: OimReleaseTrustErrorCode, message: string): never {
  throw new OimReleaseTrustError(code, message);
}

function identityKey(identity: {
  readonly integrationId: string;
  readonly version: string;
  readonly packageDigest: string;
}): string {
  return `${identity.integrationId}\n${identity.version}\n${identity.packageDigest}`;
}

function hasHooks(manifest: OimManifest): boolean {
  return (
    manifest.profiles.hooks !== undefined ||
    (manifest.hooks?.length ?? 0) > 0 ||
    (manifest.files?.some((file) => file.role === "hook") ?? false)
  );
}

function versionParts(version: string): readonly [number, number, number] {
  const [major, minor, patch] = version.split(/[+-]/, 1)[0]?.split(".").map(Number) ?? [];
  if (
    major === undefined ||
    minor === undefined ||
    patch === undefined ||
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch)
  ) {
    trustError("AUTO_PATCH_NOT_ALLOWED", "OIM auto-patch requires semantic release versions");
  }
  return [major, minor, patch];
}

function matchesSelection(candidate: OimReleaseCandidate, selection: OimReleaseSelection): boolean {
  return (
    candidate.package.manifest.metadata.id === selection.integrationId &&
    candidate.package.manifest.metadata.version === selection.version &&
    oimPackageDigest(candidate.package.manifest) === selection.packageDigest
  );
}

export function createOimReleaseTrustService(options: OimReleaseTrustServiceOptions) {
  const now = options.now ?? (() => new Date());
  const maxRevocationUpdateAttempts = options.maxRevocationUpdateAttempts ?? 3;
  if (
    !Number.isSafeInteger(maxRevocationUpdateAttempts) ||
    maxRevocationUpdateAttempts < 1 ||
    maxRevocationUpdateAttempts > 32
  ) {
    throw new Error("invalid_oim_revocation_update_attempts");
  }

  function verifyCurrentTime(
    list: VerifiedSignedOimRevocationList
  ): VerifiedSignedOimRevocationList {
    const currentTime = now().getTime();
    if (Date.parse(list.issuedAt) > currentTime) {
      trustError("REVOCATION_NOT_CURRENT", "OIM revocation list is not yet in effect");
    }
    if (Date.parse(list.expiresAt) <= currentTime) {
      trustError("REVOCATION_EXPIRED", "OIM revocation list has expired");
    }
    return list;
  }

  async function loadRevocations(
    requireCurrent: boolean
  ): Promise<VerifiedSignedOimRevocationList> {
    const input = await options.revocationStore.load();
    if (input === undefined || input === null) {
      trustError("REVOCATION_MISSING", "No signed OIM revocation list is installed");
    }
    const list = verifySignedOimRevocationList(input, options.trustedRevocationKeys);
    return requireCurrent ? verifyCurrentTime(list) : list;
  }

  function assertNotRevoked(
    release: {
      readonly integrationId: string;
      readonly version: string;
      readonly packageDigest: string;
    },
    revocations: VerifiedSignedOimRevocationList
  ): void {
    const target = identityKey(release);
    if (revocations.revocations.some((identity) => identityKey(identity) === target)) {
      trustError("OFFICIAL_RELEASE_REVOKED", "OIM release is revoked");
    }
  }

  async function authorizeVerifiedOfficialRelease(
    verified: VerifiedSignedOimRelease
  ): Promise<AuthorizedOfficialOimRelease> {
    await options.knownSignedReleaseStore.recordKnownSignedRelease({
      integrationId: verified.integrationId,
      version: verified.version,
      packageDigest: verified.packageDigest,
      keyId: verified.signerKeyId,
    });
    const revocations = await loadRevocations(true);
    assertNotRevoked(verified, revocations);
    const authorization = Object.freeze({ trustClass: "official" as const, ...verified });
    authorizedReleases.add(authorization);
    return authorization;
  }

  async function authorizeOfficialRelease(
    input: AuthorizeOfficialOimReleaseInput
  ): Promise<AuthorizedOfficialOimRelease> {
    return authorizeVerifiedOfficialRelease(
      verifySignedOimRelease(input.package, input.signedRelease, options.trustedReleaseKeys)
    );
  }

  async function authorizeSelectedOfficialRelease(
    input: AuthorizeSelectedOfficialOimReleaseInput
  ): Promise<AuthorizedOfficialOimRelease> {
    return authorizeVerifiedOfficialRelease(
      verifySelectedOimReleaseCandidate(
        input.selection,
        input.candidates,
        options.trustedReleaseKeys
      )
    );
  }

  function verifyInstalledIdentity(
    input: AuthorizeInstalledOimReleaseInput
  ): VerifiedOimReleasePackage {
    const verified = verifyOimReleasePackage(input.package);
    const provenance = input.provenance;
    if (
      provenance.integrationId !== verified.integrationId ||
      provenance.version !== verified.version ||
      provenance.packageDigest !== verified.packageDigest ||
      provenance.majorVersion !== Number(verified.version.split(".")[0])
    ) {
      trustError("PROVENANCE_MISMATCH", "Installed OIM release does not match its provenance");
    }
    return verified;
  }

  async function authorizeCommunityRelease(
    input: AuthorizeCommunityOimReleaseInput
  ): Promise<AuthorizedCommunityOimRelease> {
    const verified = verifyOimReleasePackage(input.package);
    if (input.autoPatchOptIn === true) {
      trustError("COMMUNITY_AUTO_PATCH_FORBIDDEN", "Community OIM releases cannot auto-patch");
    }
    if (hasHooks(input.package.manifest)) {
      trustError("COMMUNITY_HOOKS_FORBIDDEN", "Community OIM releases cannot contain Hooks");
    }
    if (input.approvedPackageDigest !== verified.packageDigest) {
      trustError(
        "COMMUNITY_DIGEST_REQUIRED",
        "Community OIM releases require approval of the exact package digest"
      );
    }
    if (await options.knownSignedReleaseStore.isKnownSignedRelease(verified)) {
      trustError(
        "COMMUNITY_OFFICIAL_RELEASE",
        "A known signed OIM release cannot be installed as Community"
      );
    }
    const revocations = await loadRevocations(true);
    assertNotRevoked(verified, revocations);
    const authorization = Object.freeze({
      trustClass: "community" as const,
      ...verified,
      approvedCommunityDigest: input.approvedPackageDigest,
    });
    authorizedReleases.add(authorization);
    return authorization;
  }

  async function recordKnownSignedRelease(input: unknown): Promise<void> {
    const envelope = parseSignedOimRelease(input);
    const keyring = new OimEd25519Keyring(options.trustedReleaseKeys);
    if (!keyring.has(envelope.signature.keyId) || !keyring.verifyRelease(envelope)) {
      trustError("PROVENANCE_MISMATCH", "Known OIM release signature is not trusted");
    }
    await options.knownSignedReleaseStore.recordKnownSignedRelease({
      ...envelope.release,
      keyId: envelope.signature.keyId,
    });
  }

  async function authorizeInstalledRelease(
    input: AuthorizeInstalledOimReleaseInput
  ): Promise<AuthorizedOimRelease> {
    const verified = verifyInstalledIdentity(input);
    const provenance = input.provenance;
    if (provenance.trustClass === "official") {
      if (provenance.signedRelease === undefined) {
        trustError("PROVENANCE_MISMATCH", "Official OIM provenance has no signed release");
      }
      return authorizeOfficialRelease({
        package: input.package,
        signedRelease: provenance.signedRelease,
      });
    }
    if (
      provenance.approvedCommunityDigest !== verified.packageDigest ||
      provenance.autoPatchOptIn
    ) {
      trustError("PROVENANCE_MISMATCH", "Community OIM provenance is invalid");
    }
    return authorizeCommunityRelease({
      package: input.package,
      approvedPackageDigest: provenance.approvedCommunityDigest,
    });
  }

  async function updateRevocationList(
    signedRevocationList: SignedOimRevocationList
  ): Promise<VerifiedSignedOimRevocationList> {
    const next = verifyCurrentTime(
      verifySignedOimRevocationList(signedRevocationList, options.trustedRevocationKeys)
    );
    for (let attempt = 0; attempt < maxRevocationUpdateAttempts; attempt += 1) {
      const currentInput = await options.revocationStore.load();
      const current =
        currentInput === undefined || currentInput === null
          ? undefined
          : verifySignedOimRevocationList(currentInput, options.trustedRevocationKeys);
      if (current !== undefined) {
        if (next.sequence < current.sequence) {
          trustError("REVOCATION_ROLLBACK", "OIM revocation sequence cannot decrease");
        }
        if (next.sequence === current.sequence) {
          trustError("REVOCATION_REPLAY", "OIM revocation sequence was already applied");
        }
        if (Date.parse(next.issuedAt) <= Date.parse(current.issuedAt)) {
          trustError("REVOCATION_STALE", "OIM revocation issuedAt must increase");
        }
        const nextIdentities = new Set(next.revocations.map(identityKey));
        if (current.revocations.some((identity) => !nextIdentities.has(identityKey(identity)))) {
          trustError("REVOCATION_REMOVAL", "OIM revocation updates cannot remove entries");
        }
      }
      if (
        await options.revocationStore.compareAndSwap(current?.sequence, next.signedRevocationList)
      ) {
        return next;
      }
    }
    trustError("REVOCATION_CAS_EXHAUSTED", "OIM revocation update lost concurrent races");
  }

  async function selectAutoPatch(input: SelectOimAutoPatchInput): Promise<AuthorizedOimAutoPatch> {
    if (input.provenance.trustClass !== "official" || !input.provenance.autoPatchOptIn) {
      trustError("AUTO_PATCH_NOT_ALLOWED", "OIM release is not opted in to official auto-patching");
    }
    verifyInstalledIdentity({ package: input.currentPackage, provenance: input.provenance });
    if (input.provenance.signedRelease === undefined) {
      trustError("PROVENANCE_MISMATCH", "Official OIM provenance has no signed release");
    }
    verifySignedOimRelease(
      input.currentPackage,
      input.provenance.signedRelease,
      options.trustedReleaseKeys
    );
    const authorized = await authorizeSelectedOfficialRelease({
      selection: input.selection,
      candidates: input.candidates,
    });
    const candidate = input.candidates.find((entry) => matchesSelection(entry, input.selection));
    if (candidate === undefined) {
      trustError("AUTO_PATCH_NOT_ALLOWED", "Selected OIM auto-patch candidate is unavailable");
    }
    const [currentMajor, currentMinor, currentPatch] = versionParts(
      input.currentPackage.manifest.metadata.version
    );
    const [nextMajor, nextMinor, nextPatch] = versionParts(
      candidate.package.manifest.metadata.version
    );
    if (nextMajor !== currentMajor || nextMinor !== currentMinor || nextPatch <= currentPatch) {
      trustError(
        "AUTO_PATCH_NOT_ALLOWED",
        "OIM auto-patch must be a newer patch in the same major and minor"
      );
    }
    const compatibilityIssues = [
      ...oimCompatibilityIssues(input.originalManifest, candidate.package.manifest),
      ...oimCompatibilityIssues(input.currentPackage.manifest, candidate.package.manifest),
    ];
    if (compatibilityIssues.length > 0) {
      trustError(
        "AUTO_PATCH_INCOMPATIBLE",
        `OIM auto-patch is incompatible: ${compatibilityIssues.join("; ")}`
      );
    }
    return Object.freeze({ ...authorized, package: candidate.package });
  }

  return Object.freeze({
    authorizeCommunityRelease,
    authorizeInstalledRelease,
    authorizeOfficialRelease,
    authorizeSelectedOfficialRelease,
    recordKnownSignedRelease,
    selectAutoPatch,
    updateRevocationList,
  });
}
