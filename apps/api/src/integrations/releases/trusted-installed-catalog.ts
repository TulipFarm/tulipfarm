import {
  type AuthorizedOimRelease,
  type AuthorizeHostedInstalledOimReleaseInput,
  OimPackageVerificationError,
  type OimReleasePackage,
  OimReleaseSignatureError,
  OimReleaseTrustError,
  oimManifestMajor,
  verifyOimReleasePackage,
} from "@tulipfarm/integrations";
import { artifactDirectory } from "@tulipfarm/schema";
import type { Logger, SoulGitStore, SoulIntegration } from "@tulipfarm/soul";
import type {
  InstalledOimReleaseProvenance,
  PersistedInstalledOimReleaseProvenance,
} from "@tulipfarm/storage";

interface TrustedInstalledOimCatalogTrust {
  findInstalledProvenance(
    businessId: string,
    integrationId: string,
    majorVersion: number
  ): Promise<PersistedInstalledOimReleaseProvenance | null>;
  authorizeInstalledRelease(
    input: AuthorizeHostedInstalledOimReleaseInput
  ): Promise<AuthorizedOimRelease>;
}

export interface TrustedInstalledOimCatalogDeps {
  readonly businessId: string;
  readonly integrations: () => Iterable<readonly [string, SoulIntegration]>;
  readonly trust: TrustedInstalledOimCatalogTrust;
  readonly soulStore: Pick<SoulGitStore, "lastCommitForPath">;
  readonly logger: Pick<Logger, "warn">;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameVerifiedFiles(
  left: ReturnType<typeof verifyOimReleasePackage>["files"],
  right: AuthorizedOimRelease["files"]
): boolean {
  return (
    left.length === right.length &&
    left.every((file, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        file.path === other.path &&
        file.role === other.role &&
        file.sha256 === other.sha256
      );
    })
  );
}

function expectedTrustDenial(error: unknown): boolean {
  return (
    error instanceof OimPackageVerificationError ||
    error instanceof OimReleaseSignatureError ||
    error instanceof OimReleaseTrustError
  );
}

function releasePackage(integration: SoulIntegration): OimReleasePackage | undefined {
  if (integration.oimManifest === undefined) return undefined;
  return {
    manifest: integration.oimManifest,
    files: new Map(Object.entries(integration.oimPackageFiles ?? {})),
  };
}

export class TrustedInstalledOimCatalog {
  private published: ReadonlyMap<string, SoulIntegration> = new Map();
  private refreshSequence = 0;

  constructor(private readonly deps: TrustedInstalledOimCatalogDeps) {}

  get integrations(): ReadonlyMap<string, SoulIntegration> {
    return this.published;
  }

  async packageFor(provenance: InstalledOimReleaseProvenance): Promise<OimReleasePackage> {
    const integration = this.published.get(provenance.slug);
    const package_ = integration === undefined ? undefined : releasePackage(integration);
    if (package_ === undefined) throw new Error("installed_oim_package_not_activated");
    const verified = verifyOimReleasePackage(package_);
    if (
      verified.integrationId !== provenance.integrationId ||
      verified.version !== provenance.version ||
      oimManifestMajor(package_.manifest) !== provenance.majorVersion ||
      verified.packageDigest !== provenance.packageDigest ||
      (await this.deps.soulStore.lastCommitForPath(
        artifactDirectory("Integration", provenance.slug)
      )) !== provenance.soulRevision
    ) {
      throw new Error("installed_oim_package_provenance_mismatch");
    }
    return package_;
  }

  async inspectSoulArtifact(slug: string) {
    const integration = [...this.deps.integrations()].find(([key]) => key === slug)?.[1];
    const package_ = integration === undefined ? undefined : releasePackage(integration);
    if (package_ === undefined) return null;
    const verified = verifyOimReleasePackage(package_);
    const soulRevision = await this.deps.soulStore.lastCommitForPath(
      artifactDirectory("Integration", slug)
    );
    if (soulRevision === null) return null;
    return {
      ...verified,
      majorVersion: oimManifestMajor(package_.manifest),
      soulRevision,
    };
  }

  async refresh(): Promise<ReadonlyMap<string, SoulIntegration>> {
    const sequence = ++this.refreshSequence;
    const candidates = [...this.deps.integrations()];
    const next = new Map<string, SoulIntegration>();

    for (const [slug, integration] of candidates) {
      const package_ = releasePackage(integration);
      if (package_ === undefined) continue;

      let verified: ReturnType<typeof verifyOimReleasePackage>;
      try {
        verified = verifyOimReleasePackage(package_);
      } catch (error) {
        if (!expectedTrustDenial(error)) throw error;
        this.exclude(slug, message(error));
        continue;
      }

      let majorVersion: number;
      try {
        majorVersion = oimManifestMajor(package_.manifest);
      } catch (error) {
        this.exclude(slug, message(error));
        continue;
      }
      const provenance = await this.deps.trust.findInstalledProvenance(
        this.deps.businessId,
        verified.integrationId,
        majorVersion
      );
      if (provenance === null) {
        this.exclude(slug, "verified installed provenance was not found");
        continue;
      }
      if (
        provenance.installationId.length === 0 ||
        slug !== integration.slug ||
        slug !== provenance.slug ||
        integration.sourceIntegration !== verified.integrationId ||
        provenance.businessId !== this.deps.businessId ||
        provenance.integrationId !== verified.integrationId ||
        provenance.version !== verified.version ||
        provenance.majorVersion !== majorVersion ||
        provenance.packageDigest !== verified.packageDigest
      ) {
        this.exclude(slug, "the current Soul package does not match its installed generation");
        continue;
      }

      let artifactPath: string;
      try {
        artifactPath = artifactDirectory("Integration", slug);
      } catch (error) {
        this.exclude(slug, message(error));
        continue;
      }
      const revision = await this.deps.soulStore.lastCommitForPath(artifactPath);
      if (revision !== provenance.soulRevision) {
        this.exclude(slug, "the current Soul artifact revision does not match provenance");
        continue;
      }

      let authorization: AuthorizedOimRelease;
      try {
        authorization = await this.deps.trust.authorizeInstalledRelease({
          businessId: this.deps.businessId,
          integrationId: verified.integrationId,
          majorVersion,
          package: package_,
        });
      } catch (error) {
        if (!expectedTrustDenial(error)) throw error;
        this.exclude(slug, message(error));
        continue;
      }
      if (
        authorization.integrationId !== verified.integrationId ||
        authorization.version !== verified.version ||
        authorization.packageDigest !== verified.packageDigest ||
        authorization.trustClass !== provenance.trustClass ||
        !sameVerifiedFiles(verified.files, authorization.files)
      ) {
        this.exclude(slug, "the current trust authorization does not match the Soul package");
        continue;
      }

      next.set(slug, integration);
    }

    if (sequence === this.refreshSequence) this.published = next;
    return this.published;
  }

  private exclude(slug: string, reason: string): void {
    this.deps.logger.warn(`OIM installed Integration "${slug}" was not activated: ${reason}`);
  }
}

export function createTrustedInstalledOimCatalog(
  deps: TrustedInstalledOimCatalogDeps
): TrustedInstalledOimCatalog {
  return new TrustedInstalledOimCatalog(deps);
}
