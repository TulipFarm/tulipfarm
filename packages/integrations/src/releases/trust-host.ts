import { type OimManifest, validateOimManifest } from "@tulipfarm/schema";
import type {
  AddOimTrustRootInput,
  CompareAndSwapInstalledOimReleaseProvenanceResult,
  OimReleaseSourceProvenance,
  OimReleaseTrustStore,
  PersistedInstalledOimReleaseProvenance,
  PutInstalledOimReleaseProvenanceInput,
  SetOimRevocationFeedInput,
} from "@tulipfarm/storage";
import type { OimReleaseCandidate, OimReleaseSelection } from "./candidates";
import type {
  OimReleaseInstallOperationPort,
  OimReleaseInstallSnapshot,
  OimReleaseOperation,
} from "./installer";
import type { OimReleasePackage } from "./package-verifier";
import { type SignedOimRevocationList, validateTrustedOimPublicKey } from "./signatures";
import {
  type AuthorizedOimRelease,
  assertAuthorizedOimRelease,
  createOimReleaseTrustService,
  OimReleaseTrustError,
  type OimReleaseTrustServiceOptions,
  type SelectOimAutoPatchInput,
} from "./trust-service";

type OimReleaseTrustStorePort = Pick<
  OimReleaseTrustStore,
  | "addTrustRoot"
  | "compareAndSwap"
  | "disableRevocationFeed"
  | "disableTrustRoot"
  | "findInstalledProvenance"
  | "getRevocationFeed"
  | "listAutoPatchProvenance"
  | "listTrustRoots"
  | "load"
  | "isKnownSignedRelease"
  | "putInstalledProvenance"
  | "recordKnownSignedRelease"
  | "setInstalledAutoPatchPreference"
  | "setRevocationFeed"
  | "updateRestoredSoulRevision"
>;

export interface OimReleaseTrustHostOptions {
  readonly now?: () => Date;
  readonly maxRevocationUpdateAttempts?: number;
}

export interface RecordInstalledOimReleaseInput extends RecordAuthorizedOimReleaseInput {
  readonly trustClass: "official";
}

export interface RecordCommunityOimReleaseInput extends RecordAuthorizedOimReleaseInput {
  readonly trustClass: "community";
}

export type RecordHostedOimReleaseInput =
  | RecordInstalledOimReleaseInput
  | RecordCommunityOimReleaseInput;

export interface RecordAuthorizedOimReleaseInput {
  readonly authorization: AuthorizedOimRelease;
  readonly businessId: string;
  readonly source: OimReleaseSourceProvenance;
  readonly slug: string;
  readonly soulRevision: string;
  readonly originalRequirements: OimManifest;
  readonly autoPatchOptIn: boolean;
}

export interface AuthorizeHostedInstalledOimReleaseInput {
  readonly businessId: string;
  readonly integrationId: string;
  readonly majorVersion: number;
  readonly package: OimReleasePackage;
}

export interface AuthorizeHostedSelectedOimReleaseInput {
  readonly selection: OimReleaseSelection;
  readonly candidates: readonly OimReleaseCandidate[];
}

export interface SelectHostedOimAutoPatchInput
  extends Omit<SelectOimAutoPatchInput, "originalManifest" | "provenance"> {
  readonly businessId: string;
  readonly integrationId: string;
  readonly majorVersion: number;
}

interface OimReleaseOperationStoragePort {
  begin(input: {
    readonly kind: "install" | "patch" | "replace";
    readonly next: Omit<PutInstalledOimReleaseProvenanceInput, "installationId" | "soulRevision">;
    readonly expected?: Pick<
      PersistedInstalledOimReleaseProvenance,
      | "installationId"
      | "packageDigest"
      | "slug"
      | "soulRevision"
      | "source"
      | "updatedAt"
      | "version"
    >;
    readonly packageSnapshot: OimReleaseInstallSnapshot;
    readonly startedAt: string;
  }): Promise<OimReleaseOperation>;
  get(operationId: string): Promise<OimReleaseOperation | null>;
  listPending(): Promise<readonly OimReleaseOperation[]>;
  recordPlan(operationId: string, plan: unknown, updatedAt: string): Promise<void>;
  recordSoulWrite(
    operationId: string,
    receipt: unknown,
    soulRevision: string,
    updatedAt: string
  ): Promise<void>;
  commitProvenance(
    operationId: string,
    committedAt: string
  ): Promise<CompareAndSwapInstalledOimReleaseProvenanceResult>;
  markCompleted(operationId: string, completedAt: string): Promise<void>;
  markRolledBack(operationId: string, completedAt: string): Promise<void>;
  requireReconciliation(operationId: string, reason: string, updatedAt: string): Promise<void>;
  resumeReconciliation(operationId: string, updatedAt: string): Promise<OimReleaseOperation>;
}

function releaseMajor(version: string): number {
  return Number(version.split(".")[0]);
}

function authorizedProvenanceInput(input: RecordAuthorizedOimReleaseInput) {
  assertAuthorizedOimRelease(input.authorization);
  if (input.authorization.trustClass === "official" && input.source.kind !== "git") {
    throw new OimReleaseTrustError(
      "PROVENANCE_MISMATCH",
      "Official OIM releases require immutable Git source provenance"
    );
  }
  if (input.authorization.trustClass === "community" && input.autoPatchOptIn) {
    throw new OimReleaseTrustError(
      "COMMUNITY_AUTO_PATCH_FORBIDDEN",
      "Community OIM releases cannot auto-patch"
    );
  }

  let requirements: OimManifest;
  try {
    requirements = validateOimManifest(input.originalRequirements);
  } catch {
    throw new OimReleaseTrustError(
      "PROVENANCE_MISMATCH",
      "Installed OIM release original requirements are invalid"
    );
  }
  if (
    requirements.metadata.id !== input.authorization.integrationId ||
    releaseMajor(requirements.metadata.version) !== releaseMajor(input.authorization.version)
  ) {
    throw new OimReleaseTrustError(
      "PROVENANCE_MISMATCH",
      "Installed OIM release original requirements have a different identity"
    );
  }
  return {
    businessId: input.businessId,
    integrationId: input.authorization.integrationId,
    majorVersion: releaseMajor(input.authorization.version),
    version: input.authorization.version,
    packageDigest: input.authorization.packageDigest,
    source: input.source,
    slug: input.slug,
    trustClass: input.authorization.trustClass,
    ...(input.authorization.trustClass === "official"
      ? { signedRelease: input.authorization.signedRelease }
      : { approvedCommunityDigest: input.authorization.approvedCommunityDigest }),
    originalRequirements: requirements,
    autoPatchOptIn: input.autoPatchOptIn,
  } satisfies Omit<PutInstalledOimReleaseProvenanceInput, "installationId" | "soulRevision">;
}

export function createOimReleaseTrustHost(
  store: OimReleaseTrustStorePort,
  options: OimReleaseTrustHostOptions = {}
) {
  async function service() {
    const roots = await store.listTrustRoots();
    const serviceOptions: OimReleaseTrustServiceOptions = {
      trustedReleaseKeys: roots
        .filter((root) => root.purpose === "release")
        .map(({ keyId, publicKeyPem }) => ({ keyId, publicKeyPem })),
      trustedRevocationKeys: roots
        .filter((root) => root.purpose === "revocation")
        .map(({ keyId, publicKeyPem }) => ({ keyId, publicKeyPem })),
      revocationStore: store,
      knownSignedReleaseStore: {
        isKnownSignedRelease: (identity) => store.isKnownSignedRelease(identity),
        recordKnownSignedRelease: (identity) => store.recordKnownSignedRelease(identity),
      },
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.maxRevocationUpdateAttempts === undefined
        ? {}
        : { maxRevocationUpdateAttempts: options.maxRevocationUpdateAttempts }),
    };
    return createOimReleaseTrustService(serviceOptions);
  }

  async function addTrustRoot(input: AddOimTrustRootInput) {
    validateTrustedOimPublicKey({ keyId: input.keyId, publicKeyPem: input.publicKeyPem });
    return store.addTrustRoot(input);
  }

  async function authorizeSelectedOfficialRelease(input: AuthorizeHostedSelectedOimReleaseInput) {
    return (await service()).authorizeSelectedOfficialRelease(input);
  }

  async function recordKnownSignedReleases(inputs: readonly unknown[]): Promise<void> {
    const trust = await service();
    for (const input of inputs) await trust.recordKnownSignedRelease(input);
  }

  async function recordInstalledProvenance(input: RecordAuthorizedOimReleaseInput): Promise<void> {
    await store.putInstalledProvenance({
      soulRevision: input.soulRevision,
      ...authorizedProvenanceInput(input),
    });
  }

  async function recordRestoredSoulRevision(input: {
    readonly businessId: string;
    readonly integrationId: string;
    readonly majorVersion: number;
    readonly version: string;
    readonly packageDigest: string;
    readonly slug: string;
    readonly soulRevision: string;
  }): Promise<void> {
    await store.updateRestoredSoulRevision(input);
  }

  async function findInstalledProvenance(
    businessId: string,
    integrationId: string,
    majorVersion: number
  ) {
    return store.findInstalledProvenance(businessId, integrationId, majorVersion);
  }

  async function authorizeInstalledRelease(
    input: AuthorizeHostedInstalledOimReleaseInput
  ): Promise<AuthorizedOimRelease> {
    const provenance = await store.findInstalledProvenance(
      input.businessId,
      input.integrationId,
      input.majorVersion
    );
    if (provenance === null) {
      throw new OimReleaseTrustError(
        "PROVENANCE_MISSING",
        "Installed OIM release provenance was not found"
      );
    }
    return (await service()).authorizeInstalledRelease({
      package: input.package,
      provenance,
    });
  }

  async function updateRevocationList(signedRevocationList: SignedOimRevocationList) {
    return (await service()).updateRevocationList(signedRevocationList);
  }

  async function selectAutoPatch(input: SelectHostedOimAutoPatchInput) {
    const provenance = await store.findInstalledProvenance(
      input.businessId,
      input.integrationId,
      input.majorVersion
    );
    if (provenance === null) {
      throw new OimReleaseTrustError(
        "PROVENANCE_MISSING",
        "Installed OIM release provenance was not found"
      );
    }
    let originalManifest: OimManifest;
    try {
      originalManifest = validateOimManifest(provenance.originalRequirements);
    } catch {
      throw new OimReleaseTrustError(
        "PROVENANCE_MISMATCH",
        "Installed OIM release original requirements are invalid"
      );
    }
    return (await service()).selectAutoPatch({
      provenance,
      originalManifest,
      currentPackage: input.currentPackage,
      selection: input.selection,
      candidates: input.candidates,
    });
  }

  return Object.freeze({
    addTrustRoot,
    authorizeInstalledRelease,
    authorizeSelectedOfficialRelease,
    recordKnownSignedReleases,
    disableRevocationFeed: store.disableRevocationFeed.bind(store),
    disableTrustRoot: store.disableTrustRoot.bind(store),
    findInstalledProvenance,
    getRevocationFeed: store.getRevocationFeed.bind(store),
    listAutoPatchProvenance: store.listAutoPatchProvenance.bind(store),
    listTrustRoots: store.listTrustRoots.bind(store),
    recordInstalledProvenance,
    recordRestoredSoulRevision,
    selectAutoPatch,
    setRevocationFeed(input: SetOimRevocationFeedInput) {
      return store.setRevocationFeed(input);
    },
    setInstalledAutoPatchPreference: store.setInstalledAutoPatchPreference.bind(store),
    updateRevocationList,
  });
}

export function createOimReleaseInstallOperationHost(
  operations: OimReleaseOperationStoragePort
): OimReleaseInstallOperationPort {
  return {
    async beginAuthorized(input) {
      if (
        input.packageSnapshot.integrationId !== input.authorization.integrationId ||
        input.packageSnapshot.version !== input.authorization.version ||
        input.packageSnapshot.majorVersion !== releaseMajor(input.authorization.version) ||
        input.packageSnapshot.packageDigest !== input.authorization.packageDigest
      ) {
        throw new OimReleaseTrustError(
          "PROVENANCE_MISMATCH",
          "The durable OIM package snapshot does not match its authorization"
        );
      }
      const next = authorizedProvenanceInput({
        authorization: input.authorization,
        businessId: input.businessId,
        source: input.source,
        slug: input.slug,
        soulRevision: "pending",
        originalRequirements: input.originalRequirements,
        autoPatchOptIn: input.autoPatchOptIn,
      });
      return operations.begin({
        kind: input.kind,
        next,
        packageSnapshot: input.packageSnapshot,
        ...(input.expected === undefined
          ? {}
          : {
              expected: {
                installationId: input.expected.installationId,
                version: input.expected.version,
                packageDigest: input.expected.packageDigest,
                source: input.expected.source,
                slug: input.expected.slug,
                soulRevision: input.expected.soulRevision,
                updatedAt: input.expected.updatedAt,
              },
            }),
        startedAt: input.startedAt,
      });
    },
    get: (operationId) => operations.get(operationId),
    listPending: () => operations.listPending(),
    recordPlan: (operationId, plan, updatedAt) =>
      operations.recordPlan(operationId, plan, updatedAt),
    recordSoulWrite: (operationId, receipt, soulRevision, updatedAt) =>
      operations.recordSoulWrite(operationId, receipt, soulRevision, updatedAt),
    commitProvenance: (operationId, committedAt) =>
      operations.commitProvenance(operationId, committedAt),
    markCompleted: (operationId, completedAt) => operations.markCompleted(operationId, completedAt),
    markRolledBack: (operationId, completedAt) =>
      operations.markRolledBack(operationId, completedAt),
    requireReconciliation: (operationId, reason, updatedAt) =>
      operations.requireReconciliation(operationId, reason, updatedAt),
    resumeReconciliation: (operationId, updatedAt) =>
      operations.resumeReconciliation(operationId, updatedAt),
  };
}
