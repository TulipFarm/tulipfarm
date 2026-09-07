import {
  type OimHook,
  type OimManifest,
  oimCompatibilityIssues,
  oimPackageDigest,
  oimPackageIssues,
} from "@tulipfarm/schema";
import {
  OimEd25519Keyring,
  type OimReleasePackage,
  type SignedOimRelease,
  type SignedOimRevocationList,
  type TrustedOimPublicKey,
} from "./signatures";

export type { SignedOimRevocationList } from "./signatures";

export type OimReleaseTrustErrorCode =
  | "AUTO_PATCH_NOT_ALLOWED"
  | "COMMUNITY_DIGEST_APPROVAL_REQUIRED"
  | "HOOK_AUTHORIZATION_MISMATCH"
  | "HOOK_DECLARATION_INVALID"
  | "HOOK_EXECUTION_GRANT_INVALID"
  | "HOOKS_REQUIRE_OFFICIAL_SIGNATURE"
  | "PACKAGE_AUTHORIZATION_INVALID"
  | "PACKAGE_INVALID"
  | "RELEASE_ENVELOPE_INVALID"
  | "RELEASE_IDENTITY_MISMATCH"
  | "RELEASE_REVOKED"
  | "RELEASE_SIGNATURE_INVALID"
  | "RELEASE_SIGNER_UNKNOWN"
  | "REVOCATION_LIST_EXPIRED"
  | "REVOCATION_LIST_INVALID"
  | "REVOCATION_LIST_MISSING"
  | "REVOCATION_SET_ROLLBACK"
  | "REVOCATION_SEQUENCE_STALE"
  | "REVOCATION_SIGNER_UNKNOWN"
  | "REVOCATION_TIME_ROLLBACK"
  | "REVOCATION_UPDATE_CONFLICT";

export class OimReleaseTrustError extends Error {
  constructor(
    readonly code: OimReleaseTrustErrorCode,
    message: string
  ) {
    super(message);
    this.name = "OimReleaseTrustError";
  }
}

export interface OimRevocationStateStore {
  load(): Promise<unknown>;
  compareAndSwap(
    expectedSequence: number | undefined,
    next: SignedOimRevocationList
  ): Promise<boolean>;
}

export interface OimReleaseTrustConfig {
  readonly trustedReleaseKeys: readonly TrustedOimPublicKey[];
  readonly trustedRevocationKeys: readonly TrustedOimPublicKey[];
  readonly revocationStore: OimRevocationStateStore;
  readonly now?: () => Date;
}

export interface OimPackageAuthorizationInput {
  readonly package: OimReleasePackage;
  readonly signedRelease?: unknown;
  readonly approvedCommunityDigest?: string;
}

interface OimPackageAuthorizationBase {
  readonly integrationId: string;
  readonly version: string;
  readonly packageDigest: string;
}

export interface OimOfficialPackageAuthorization extends OimPackageAuthorizationBase {
  readonly trustClass: "official";
  readonly hooksAllowed: boolean;
  readonly signerKeyId: string;
  readonly revocationSequence: number;
  readonly signedRelease: SignedOimRelease;
}

export interface OimCommunityPackageAuthorization extends OimPackageAuthorizationBase {
  readonly trustClass: "community";
  readonly hooksAllowed: false;
  readonly approvedCommunityDigest: string;
}

export type OimPackageAuthorization =
  | OimOfficialPackageAuthorization
  | OimCommunityPackageAuthorization;

export type OimHookPackageAuthorization = OimOfficialPackageAuthorization & {
  readonly hooksAllowed: true;
};

const verifiedPackageAuthorizations = new WeakSet<object>();

export function assertOimPackageAuthorization(authorization: OimPackageAuthorization): void {
  if (!verifiedPackageAuthorizations.has(authorization)) {
    trustError(
      "PACKAGE_AUTHORIZATION_INVALID",
      "OIM package authorization was not issued by the release trust service"
    );
  }
}

export interface OimHookExecutionGrant {
  readonly trustClass: "official";
  readonly integrationId: string;
  readonly version: string;
  readonly packageDigest: string;
  readonly signerKeyId: string;
  readonly revocationSequence: number;
  readonly hookKind: OimHook["kind"];
  readonly file: string;
  readonly fileSha256: string;
  readonly exportName: string;
  readonly source: string;
}

export function assertOimHooksAllowed(
  authorization: OimPackageAuthorization
): asserts authorization is OimHookPackageAuthorization {
  assertOimPackageAuthorization(authorization);
  if (authorization.trustClass !== "official" || !authorization.hooksAllowed) {
    trustError(
      "HOOKS_REQUIRE_OFFICIAL_SIGNATURE",
      "OIM Hooks require a trusted official release signature"
    );
  }
}

const hookExecutionGrants = new WeakSet<object>();

export function issueOimHookExecutionGrant(
  authorization: OimPackageAuthorization,
  packageInput: OimReleasePackage,
  hookKind: OimHook["kind"],
  exportName: string
): OimHookExecutionGrant {
  assertOimHooksAllowed(authorization);
  const identity = packageIdentity(packageInput);
  if (
    authorization.integrationId !== identity.integrationId ||
    authorization.version !== identity.version ||
    authorization.packageDigest !== identity.packageDigest
  ) {
    trustError(
      "HOOK_AUTHORIZATION_MISMATCH",
      "OIM Hook authorization does not bind the supplied package"
    );
  }
  const hooks = (packageInput.manifest.hooks ?? []).filter(
    (hook) => hook.kind === hookKind && hook.export === exportName
  );
  if (hooks.length !== 1) {
    trustError(
      "HOOK_DECLARATION_INVALID",
      `OIM package must declare exactly one ${hookKind} Hook export named ${exportName}`
    );
  }
  const hook = hooks[0];
  const file = packageInput.manifest.files?.find((candidate) => candidate.path === hook?.file);
  const content = hook === undefined ? undefined : packageInput.files.get(hook.file);
  if (hook === undefined || file?.role !== "hook" || content === undefined) {
    trustError("HOOK_DECLARATION_INVALID", "OIM Hook does not resolve to a reviewed Hook file");
  }
  const source =
    typeof content === "string"
      ? content
      : new TextDecoder("utf-8", { fatal: true }).decode(content);
  const grant = Object.freeze({
    trustClass: "official" as const,
    integrationId: identity.integrationId,
    version: identity.version,
    packageDigest: identity.packageDigest,
    signerKeyId: authorization.signerKeyId,
    revocationSequence: authorization.revocationSequence,
    hookKind,
    file: hook.file,
    fileSha256: file.sha256,
    exportName,
    source,
  });
  hookExecutionGrants.add(grant);
  return grant;
}

export function assertOimHookExecutionGrant(
  value: unknown
): asserts value is OimHookExecutionGrant {
  if (!isRecord(value) || !hookExecutionGrants.has(value)) {
    trustError("HOOK_EXECUTION_GRANT_INVALID", "OIM Hook execution grant is not trusted");
  }
}

export interface OimAutoPatchRequest {
  readonly optedIn: boolean;
  readonly originalRequirements: OimManifest;
  readonly current: OimPackageAuthorizationInput;
  readonly candidate: OimPackageAuthorizationInput;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function trustError(code: OimReleaseTrustErrorCode, message: string): never {
  throw new OimReleaseTrustError(code, message);
}

function packageIdentity(packageInput: OimReleasePackage) {
  const issues = oimPackageIssues(packageInput.manifest, packageInput.files);
  if (issues.length > 0) {
    trustError("PACKAGE_INVALID", `OIM package is invalid: ${issues.join("; ")}`);
  }
  return {
    integrationId: packageInput.manifest.metadata.id,
    version: packageInput.manifest.metadata.version,
    packageDigest: oimPackageDigest(packageInput.manifest),
  };
}

function declaresHooks(manifest: OimManifest): boolean {
  return (
    (manifest.hooks?.length ?? 0) > 0 ||
    (manifest.files?.some((file) => file.role === "hook") ?? false)
  );
}

function parseTime(value: string): number | undefined {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? timestamp
    : undefined;
}

function parseVersion(version: string): readonly [number, number, number] | undefined {
  const match = SEMVER_PATTERN.exec(version);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isSignature(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["algorithm", "keyId", "value"])) return false;
  if (
    value.algorithm !== "Ed25519" ||
    typeof value.keyId !== "string" ||
    value.keyId.length === 0 ||
    value.keyId.length > 128 ||
    typeof value.value !== "string"
  ) {
    return false;
  }
  try {
    const bytes = Buffer.from(value.value, "base64");
    return bytes.length === 64 && bytes.toString("base64") === value.value;
  } catch {
    return false;
  }
}

function parseSignedRelease(value: unknown): SignedOimRelease {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["envelopeVersion", "release", "signature"]) ||
    value.envelopeVersion !== 1 ||
    !isRecord(value.release) ||
    !hasExactKeys(value.release, ["integrationId", "packageDigest", "version"]) ||
    typeof value.release.integrationId !== "string" ||
    value.release.integrationId.length === 0 ||
    typeof value.release.version !== "string" ||
    parseVersion(value.release.version) === undefined ||
    typeof value.release.packageDigest !== "string" ||
    !SHA256_PATTERN.test(value.release.packageDigest) ||
    !isSignature(value.signature)
  ) {
    trustError("RELEASE_ENVELOPE_INVALID", "OIM release envelope is malformed");
  }
  return value as unknown as SignedOimRelease;
}

function immutableSignedRelease(envelope: SignedOimRelease): SignedOimRelease {
  return Object.freeze({
    envelopeVersion: 1,
    release: Object.freeze({ ...envelope.release }),
    signature: Object.freeze({ ...envelope.signature }),
  });
}

function parseRevocationEnvelope(value: unknown): SignedOimRevocationList {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["envelopeVersion", "list", "signature"]) ||
    value.envelopeVersion !== 1 ||
    !isRecord(value.list) ||
    !hasExactKeys(value.list, ["expiresAt", "issuedAt", "revocations", "sequence"]) ||
    !isSignature(value.signature)
  ) {
    trustError("REVOCATION_LIST_INVALID", "OIM revocation list envelope is malformed");
  }
  const list = value.list;
  if (
    !Number.isSafeInteger(list.sequence) ||
    (list.sequence as number) < 1 ||
    typeof list.issuedAt !== "string" ||
    typeof list.expiresAt !== "string" ||
    parseTime(list.issuedAt) === undefined ||
    parseTime(list.expiresAt) === undefined ||
    !Array.isArray(list.revocations)
  ) {
    trustError("REVOCATION_LIST_INVALID", "OIM revocation list envelope is malformed");
  }
  const identities = new Set<string>();
  for (const revocation of list.revocations) {
    if (
      !isRecord(revocation) ||
      !hasExactKeys(revocation, ["integrationId", "packageDigest", "reason", "version"]) ||
      typeof revocation.integrationId !== "string" ||
      typeof revocation.version !== "string" ||
      typeof revocation.packageDigest !== "string" ||
      typeof revocation.reason !== "string"
    ) {
      trustError("REVOCATION_LIST_INVALID", "OIM revocation list contains an invalid entry");
    }
    const identity = `${revocation.integrationId}\n${revocation.version}\n${revocation.packageDigest}`;
    if (
      revocation.integrationId.length === 0 ||
      parseVersion(revocation.version) === undefined ||
      !SHA256_PATTERN.test(revocation.packageDigest) ||
      revocation.reason.length === 0 ||
      identities.has(identity)
    ) {
      trustError("REVOCATION_LIST_INVALID", "OIM revocation list contains an invalid entry");
    }
    identities.add(identity);
  }
  return value as unknown as SignedOimRevocationList;
}

function immutableRevocationEnvelope(envelope: SignedOimRevocationList): SignedOimRevocationList {
  return Object.freeze({
    envelopeVersion: 1,
    list: Object.freeze({
      sequence: envelope.list.sequence,
      issuedAt: envelope.list.issuedAt,
      expiresAt: envelope.list.expiresAt,
      revocations: Object.freeze(
        envelope.list.revocations.map((revocation) => Object.freeze({ ...revocation }))
      ),
    }),
    signature: Object.freeze({ ...envelope.signature }),
  });
}

export function createOimReleaseTrustService(config: OimReleaseTrustConfig) {
  const releaseKeys = new OimEd25519Keyring(config.trustedReleaseKeys);
  const revocationKeys = new OimEd25519Keyring(config.trustedRevocationKeys);
  const now = config.now ?? (() => new Date());

  function verifyRevocationEnvelope(
    input: unknown,
    requireFresh: boolean
  ): SignedOimRevocationList {
    const envelope = parseRevocationEnvelope(input);
    if (!revocationKeys.has(envelope.signature.keyId)) {
      trustError(
        "REVOCATION_SIGNER_UNKNOWN",
        `OIM revocation signer ${envelope.signature.keyId} is not trusted`
      );
    }
    if (!revocationKeys.verifyRevocationList(envelope)) {
      trustError("REVOCATION_LIST_INVALID", "OIM revocation list signature is invalid");
    }
    const issuedAt = parseTime(envelope.list.issuedAt) ?? Number.NaN;
    const expiresAt = parseTime(envelope.list.expiresAt) ?? Number.NaN;
    if (expiresAt <= issuedAt || issuedAt > now().getTime()) {
      trustError("REVOCATION_LIST_INVALID", "OIM revocation list time window is invalid");
    }
    if (requireFresh && expiresAt <= now().getTime()) {
      trustError("REVOCATION_LIST_EXPIRED", "OIM revocation list has expired");
    }
    return envelope;
  }

  async function currentRevocations(): Promise<SignedOimRevocationList> {
    const current = await config.revocationStore.load();
    if (current === undefined) {
      trustError(
        "REVOCATION_LIST_MISSING",
        "A current signed OIM revocation list is required for official trust"
      );
    }
    return verifyRevocationEnvelope(current, true);
  }

  async function authorize(input: OimPackageAuthorizationInput): Promise<OimPackageAuthorization> {
    const identity = packageIdentity(input.package);
    const hasHooks = declaresHooks(input.package.manifest);
    if (input.signedRelease === undefined) {
      if (input.approvedCommunityDigest !== identity.packageDigest) {
        trustError(
          "COMMUNITY_DIGEST_APPROVAL_REQUIRED",
          "Unsigned Community OIM packages require approval of the exact package digest"
        );
      }
      if (hasHooks) {
        trustError(
          "HOOKS_REQUIRE_OFFICIAL_SIGNATURE",
          "OIM Hooks require a trusted official release signature"
        );
      }
      const authorization = Object.freeze({
        trustClass: "community",
        ...identity,
        hooksAllowed: false,
        approvedCommunityDigest: identity.packageDigest,
      });
      verifiedPackageAuthorizations.add(authorization);
      return authorization;
    }

    const signedRelease = immutableSignedRelease(parseSignedRelease(input.signedRelease));
    if (!releaseKeys.has(signedRelease.signature.keyId)) {
      trustError(
        "RELEASE_SIGNER_UNKNOWN",
        `OIM release signer ${signedRelease.signature.keyId} is not trusted`
      );
    }
    if (!releaseKeys.verifyRelease(signedRelease)) {
      trustError("RELEASE_SIGNATURE_INVALID", "OIM release signature is invalid");
    }
    if (
      signedRelease.envelopeVersion !== 1 ||
      signedRelease.release.integrationId !== identity.integrationId ||
      signedRelease.release.version !== identity.version ||
      signedRelease.release.packageDigest !== identity.packageDigest
    ) {
      trustError(
        "RELEASE_IDENTITY_MISMATCH",
        "OIM release signature does not bind this package identity"
      );
    }

    const revocations = await currentRevocations();
    if (
      revocations.list.revocations.some(
        (revocation) =>
          revocation.integrationId === identity.integrationId &&
          revocation.version === identity.version &&
          revocation.packageDigest === identity.packageDigest
      )
    ) {
      trustError("RELEASE_REVOKED", "OIM release is revoked");
    }
    const authorization = Object.freeze({
      trustClass: "official",
      ...identity,
      hooksAllowed: hasHooks,
      signerKeyId: signedRelease.signature.keyId,
      revocationSequence: revocations.list.sequence,
      signedRelease,
    });
    verifiedPackageAuthorizations.add(authorization);
    return authorization;
  }

  function verifyOfficialIdentity(input: OimPackageAuthorizationInput): void {
    const identity = packageIdentity(input.package);
    if (input.signedRelease === undefined) {
      trustError(
        "AUTO_PATCH_NOT_ALLOWED",
        "Automatic OIM patches require an installed trusted release"
      );
    }
    const signedRelease = parseSignedRelease(input.signedRelease);
    if (!releaseKeys.has(signedRelease.signature.keyId)) {
      trustError(
        "AUTO_PATCH_NOT_ALLOWED",
        "Automatic OIM patches require an installed trusted release"
      );
    }
    if (!releaseKeys.verifyRelease(signedRelease)) {
      trustError("AUTO_PATCH_NOT_ALLOWED", "Installed OIM release signature is no longer trusted");
    }
    if (
      signedRelease.envelopeVersion !== 1 ||
      signedRelease.release.integrationId !== identity.integrationId ||
      signedRelease.release.version !== identity.version ||
      signedRelease.release.packageDigest !== identity.packageDigest
    ) {
      trustError(
        "AUTO_PATCH_NOT_ALLOWED",
        "Installed OIM release signature does not bind the installed package"
      );
    }
  }

  return Object.freeze({
    authorizeInstall: authorize,
    authorizeRuntime: authorize,
    authorizeToolCompilation: authorize,

    async acceptRevocationList(nextInput: unknown): Promise<void> {
      const next = immutableRevocationEnvelope(verifyRevocationEnvelope(nextInput, true));
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const stored = await config.revocationStore.load();
        const current = stored === undefined ? undefined : verifyRevocationEnvelope(stored, false);
        if (current !== undefined) {
          if (next.list.sequence <= current.list.sequence) {
            trustError(
              "REVOCATION_SEQUENCE_STALE",
              "OIM revocation sequence must increase monotonically"
            );
          }
          if (
            (parseTime(next.list.issuedAt) ?? Number.NaN) <=
            (parseTime(current.list.issuedAt) ?? Number.NaN)
          ) {
            trustError(
              "REVOCATION_TIME_ROLLBACK",
              "OIM revocation issuedAt must increase monotonically"
            );
          }
          const nextRevocations = new Set(
            next.list.revocations.map(
              (revocation) =>
                `${revocation.integrationId}\n${revocation.version}\n${revocation.packageDigest}`
            )
          );
          if (
            current.list.revocations.some(
              (revocation) =>
                !nextRevocations.has(
                  `${revocation.integrationId}\n${revocation.version}\n${revocation.packageDigest}`
                )
            )
          ) {
            trustError(
              "REVOCATION_SET_ROLLBACK",
              "OIM revocation updates cannot remove a revoked release"
            );
          }
        }
        if (await config.revocationStore.compareAndSwap(current?.list.sequence, next)) return;
      }
      trustError(
        "REVOCATION_UPDATE_CONFLICT",
        "OIM revocation list changed concurrently; retry the update"
      );
    },

    async authorizeAutoPatch(request: OimAutoPatchRequest): Promise<OimPackageAuthorization> {
      if (!request.optedIn) {
        trustError("AUTO_PATCH_NOT_ALLOWED", "Automatic OIM patch updates are not enabled");
      }
      const original = request.originalRequirements;
      verifyOfficialIdentity(request.current);
      verifyOfficialIdentity(request.candidate);
      const current = request.current.package.manifest;
      const candidate = request.candidate.package.manifest;
      const originalVersion = parseVersion(original.metadata.version);
      const currentVersion = parseVersion(current.metadata.version);
      const candidateVersion = parseVersion(candidate.metadata.version);
      if (
        originalVersion === undefined ||
        currentVersion === undefined ||
        candidateVersion === undefined ||
        original.metadata.id !== current.metadata.id ||
        original.metadata.id !== candidate.metadata.id ||
        candidateVersion[0] !== currentVersion[0] ||
        candidateVersion[1] !== currentVersion[1] ||
        candidateVersion[2] <= currentVersion[2]
      ) {
        trustError(
          "AUTO_PATCH_NOT_ALLOWED",
          "Automatic OIM updates must be a newer patch of the installed Integration"
        );
      }
      const issues = [
        ...oimCompatibilityIssues(original, candidate),
        ...oimCompatibilityIssues(current, candidate),
      ];
      if (issues.length > 0) {
        trustError(
          "AUTO_PATCH_NOT_ALLOWED",
          `Automatic OIM patch violates original requirements: ${issues.join("; ")}`
        );
      }
      const authorization = await authorize(request.candidate);
      if (authorization.trustClass !== "official") {
        trustError("AUTO_PATCH_NOT_ALLOWED", "Automatic OIM patches must be trusted releases");
      }
      return authorization;
    },
  });
}

export type OimReleaseTrustService = ReturnType<typeof createOimReleaseTrustService>;
