import { validateTrustedOimPublicKey } from "@tulipfarm/integrations/src/releases/signatures";
import {
  assertOimPackageAuthorization,
  createOimReleaseTrustService,
  type OimAutoPatchRequest,
  type OimPackageAuthorization,
  type OimPackageAuthorizationInput,
  OimReleaseTrustError,
  type OimReleaseTrustService,
  type SignedOimRevocationList,
} from "@tulipfarm/integrations/src/releases/trust-service";
import { type OimManifest, oimPackageDigest, oimPackageIssues } from "@tulipfarm/schema";
import {
  type AddOimTrustRootInput,
  type InstalledOimReleaseProvenance,
  type OimReleaseTrustStore,
  type OimRevocationFeed,
  OimTrustRootConflictError,
  type OimTrustRootPurpose,
  type PutInstalledOimReleaseProvenanceInput,
} from "@tulipfarm/storage";

export type OimReleaseAdminErrorCode =
  | "community_auto_patch_forbidden"
  | "feed_invalid"
  | "feed_not_found"
  | "installed_release_not_found"
  | "root_conflict"
  | "root_invalid"
  | "root_not_found";

export class OimReleaseAdminError extends Error {
  constructor(
    readonly code: OimReleaseAdminErrorCode,
    message: string
  ) {
    super(message);
    this.name = "OimReleaseAdminError";
  }
}

export interface AddOimReleaseTrustRootRequest {
  readonly purpose: OimTrustRootPurpose;
  readonly keyId: string;
  readonly publicKeyPem: string;
  readonly actorId: string;
}

export interface RecordInstalledOimReleaseRequest {
  readonly authorization: OimPackageAuthorization;
  readonly businessId: string;
  readonly source: string;
  readonly originalRequirements: OimManifest;
  readonly autoPatchOptIn: boolean;
}

export interface InstalledOimPackageAuthorizationRequest {
  readonly businessId: string;
  readonly package: OimPackageAuthorizationInput["package"];
}

export type OimInstalledReleaseTrustErrorCode =
  | "installed_provenance_mismatch"
  | "installed_provenance_missing";

export class OimInstalledReleaseTrustError extends Error {
  constructor(
    readonly code: OimInstalledReleaseTrustErrorCode,
    message: string
  ) {
    super(message);
    this.name = "OimInstalledReleaseTrustError";
  }
}

export type OimReleaseTrustStorePort = Pick<
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
  | "putInstalledProvenance"
  | "setInstalledAutoPatchPreference"
  | "setRevocationFeed"
>;

/** Builds trust services from the currently active operator-managed roots on every use. */
export class OimReleaseTrustHost {
  constructor(
    private readonly store: OimReleaseTrustStorePort,
    private readonly now: () => Date = () => new Date()
  ) {}

  listRoots(includeDisabled = false) {
    return this.store.listTrustRoots(includeDisabled);
  }

  async addRoot(input: AddOimReleaseTrustRootRequest) {
    try {
      if (input.publicKeyPem.includes("PRIVATE KEY")) throw new Error("private key refused");
      validateTrustedOimPublicKey({
        keyId: input.keyId,
        publicKeyPem: input.publicKeyPem,
      });
    } catch {
      throw new OimReleaseAdminError("root_invalid", "OIM trust roots must be Ed25519 public keys");
    }
    try {
      const stored: AddOimTrustRootInput = {
        purpose: input.purpose,
        keyId: input.keyId,
        publicKeyPem: input.publicKeyPem,
        createdBy: input.actorId,
      };
      return await this.store.addTrustRoot(stored);
    } catch (error) {
      if (error instanceof OimTrustRootConflictError) {
        throw new OimReleaseAdminError("root_conflict", error.message);
      }
      throw error;
    }
  }

  async disableRoot(purpose: OimTrustRootPurpose, keyId: string, actorId: string) {
    const root = await this.store.disableTrustRoot(purpose, keyId, actorId);
    if (root === null) {
      throw new OimReleaseAdminError(
        "root_not_found",
        `OIM ${purpose} trust root ${keyId} does not exist`
      );
    }
    return root;
  }

  getRevocationFeed(): Promise<OimRevocationFeed | null> {
    return this.store.getRevocationFeed();
  }

  async setRevocationFeed(url: string, actorId: string): Promise<OimRevocationFeed> {
    try {
      const parsed = new URL(url);
      if (
        parsed.protocol !== "https:" ||
        parsed.username !== "" ||
        parsed.password !== "" ||
        parsed.hash !== ""
      ) {
        throw new Error("invalid");
      }
    } catch {
      throw new OimReleaseAdminError(
        "feed_invalid",
        "OIM revocation feed must be a credential-free HTTPS URL"
      );
    }
    return this.store.setRevocationFeed({ url, updatedBy: actorId });
  }

  async disableRevocationFeed(actorId: string): Promise<void> {
    if (!(await this.store.disableRevocationFeed(actorId))) {
      throw new OimReleaseAdminError(
        "feed_not_found",
        "No active OIM revocation feed is configured"
      );
    }
  }

  async trustService(): Promise<OimReleaseTrustService> {
    const roots = await this.store.listTrustRoots();
    return createOimReleaseTrustService({
      trustedReleaseKeys: roots
        .filter((root) => root.purpose === "release")
        .map((root) => ({ keyId: root.keyId, publicKeyPem: root.publicKeyPem })),
      trustedRevocationKeys: roots
        .filter((root) => root.purpose === "revocation")
        .map((root) => ({ keyId: root.keyId, publicKeyPem: root.publicKeyPem })),
      revocationStore: this.store,
      now: this.now,
    });
  }

  async authorizeInstall(input: OimPackageAuthorizationInput): Promise<OimPackageAuthorization> {
    return (await this.trustService()).authorizeInstall(input);
  }

  async authorizeRuntime(input: OimPackageAuthorizationInput): Promise<OimPackageAuthorization> {
    return (await this.trustService()).authorizeRuntime(input);
  }

  async authorizeToolCompilation(
    input: OimPackageAuthorizationInput
  ): Promise<OimPackageAuthorization> {
    return (await this.trustService()).authorizeToolCompilation(input);
  }

  async authorizeAutoPatch(input: OimAutoPatchRequest): Promise<OimPackageAuthorization> {
    return (await this.trustService()).authorizeAutoPatch(input);
  }

  async installedAuthorizationInput(
    input: InstalledOimPackageAuthorizationRequest
  ): Promise<OimPackageAuthorizationInput> {
    const issues = oimPackageIssues(input.package.manifest, input.package.files);
    const integrationId = input.package.manifest.metadata.id;
    const version = input.package.manifest.metadata.version;
    const major = /^(0|[1-9]\d*)\./.exec(version);
    if (issues.length > 0 || major === null) {
      throw new OimInstalledReleaseTrustError(
        "installed_provenance_mismatch",
        "Installed OIM package does not match valid durable provenance"
      );
    }
    const majorVersion = Number(major[1]);
    const packageDigest = oimPackageDigest(input.package.manifest);
    const provenance = await this.store.findInstalledProvenance(
      input.businessId,
      integrationId,
      majorVersion
    );
    if (provenance === null) {
      throw new OimInstalledReleaseTrustError(
        "installed_provenance_missing",
        `Installed OIM package ${integrationId}@${version} has no durable provenance`
      );
    }
    if (
      provenance.version !== version ||
      provenance.packageDigest !== packageDigest ||
      provenance.integrationId !== integrationId ||
      provenance.majorVersion !== majorVersion
    ) {
      throw new OimInstalledReleaseTrustError(
        "installed_provenance_mismatch",
        `Installed OIM package ${integrationId}@${version} does not match durable provenance`
      );
    }
    if (provenance.trustClass === "official" && provenance.signedRelease !== undefined) {
      return Object.freeze({ package: input.package, signedRelease: provenance.signedRelease });
    }
    if (
      provenance.trustClass === "community" &&
      provenance.approvedCommunityDigest === packageDigest
    ) {
      return Object.freeze({
        package: input.package,
        approvedCommunityDigest: provenance.approvedCommunityDigest,
      });
    }
    throw new OimInstalledReleaseTrustError(
      "installed_provenance_mismatch",
      `Installed OIM package ${integrationId}@${version} has invalid durable provenance`
    );
  }

  async authorizeInstalledRuntime(
    input: InstalledOimPackageAuthorizationRequest
  ): Promise<OimPackageAuthorization> {
    return this.authorizeRuntime(await this.installedAuthorizationInput(input));
  }

  async authorizeInstalledToolCompilation(
    input: InstalledOimPackageAuthorizationRequest
  ): Promise<OimPackageAuthorization> {
    return this.authorizeToolCompilation(await this.installedAuthorizationInput(input));
  }

  recordInstalledProvenance(input: RecordInstalledOimReleaseRequest): Promise<void> {
    assertOimPackageAuthorization(input.authorization);
    if (input.authorization.trustClass === "community" && input.autoPatchOptIn) {
      throw new OimReleaseTrustError(
        "AUTO_PATCH_NOT_ALLOWED",
        "Automatic OIM patch updates require a trusted Official release"
      );
    }
    const majorVersion = Number(input.authorization.version.split(".", 1)[0]);
    const record: PutInstalledOimReleaseProvenanceInput = {
      businessId: input.businessId,
      integrationId: input.authorization.integrationId,
      majorVersion,
      version: input.authorization.version,
      packageDigest: input.authorization.packageDigest,
      source: input.source,
      trustClass: input.authorization.trustClass,
      ...(input.authorization.trustClass === "official"
        ? { signedRelease: input.authorization.signedRelease }
        : { approvedCommunityDigest: input.authorization.approvedCommunityDigest }),
      originalRequirements: input.originalRequirements,
      autoPatchOptIn: input.autoPatchOptIn,
    };
    return this.store.putInstalledProvenance(record);
  }

  installedProvenance(
    businessId: string,
    integrationId: string,
    majorVersion: number
  ): Promise<InstalledOimReleaseProvenance | null> {
    return this.store.findInstalledProvenance(businessId, integrationId, majorVersion);
  }

  async getInstalledAutoPatchPreference(
    businessId: string,
    integrationId: string,
    majorVersion: number
  ): Promise<InstalledOimReleaseProvenance> {
    const provenance = await this.store.findInstalledProvenance(
      businessId,
      integrationId,
      majorVersion
    );
    if (provenance === null) {
      throw new OimReleaseAdminError(
        "installed_release_not_found",
        `Installed OIM release ${integrationId}@${majorVersion} has no durable provenance`
      );
    }
    return provenance;
  }

  async setInstalledAutoPatchPreference(
    businessId: string,
    integrationId: string,
    majorVersion: number,
    enabled: boolean
  ): Promise<InstalledOimReleaseProvenance> {
    try {
      const provenance = await this.store.setInstalledAutoPatchPreference(
        businessId,
        integrationId,
        majorVersion,
        enabled
      );
      if (provenance === null) {
        throw new OimReleaseAdminError(
          "installed_release_not_found",
          `Installed OIM release ${integrationId}@${majorVersion} has no durable provenance`
        );
      }
      return provenance;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "community_oim_release_auto_patch_forbidden"
      ) {
        throw new OimReleaseAdminError(
          "community_auto_patch_forbidden",
          "Automatic OIM patch updates require a trusted Official release"
        );
      }
      throw error;
    }
  }

  async acceptRevocationList(envelope: unknown): Promise<SignedOimRevocationList> {
    const trust = await this.trustService();
    await trust.acceptRevocationList(envelope);
    const stored = await this.store.load();
    if (stored === undefined) {
      throw new Error("accepted OIM revocation list is missing from durable storage");
    }
    return stored as SignedOimRevocationList;
  }
}
