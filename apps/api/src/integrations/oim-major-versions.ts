import { type OimManifest, oimToolId } from "@tulipfarm/schema";
import type { SoulIntegration } from "@tulipfarm/soul";

const SOUL_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type OimMajorLifecycleErrorCode =
  | "ambiguous_alias"
  | "connection_mismatch"
  | "duplicate_major"
  | "format_collision"
  | "invalid_slug"
  | "invalid_version"
  | "slug_collision";

export class OimMajorLifecycleError extends Error {
  constructor(
    readonly code: OimMajorLifecycleErrorCode,
    message: string
  ) {
    super(message);
    this.name = "OimMajorLifecycleError";
  }
}

export interface OimMajorArtifact {
  readonly slug: string;
  readonly integrationId: string;
  readonly majorVersion: number;
  readonly manifest: OimManifest;
}

export interface OimMajorInstallTarget {
  readonly slug: string;
  readonly integrationId: string;
  readonly majorVersion: number;
  readonly disposition: "install" | "update";
}

export interface OimConnectionMajorBinding {
  readonly id: string;
  readonly integration: {
    readonly id: string;
    readonly majorVersion: number;
  };
}

export function oimManifestMajor(manifest: Pick<OimManifest, "metadata">): number {
  const match = /^(0|[1-9]\d*)\./.exec(manifest.metadata.version);
  const majorVersion = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(majorVersion) || majorVersion < 0) {
    throw new OimMajorLifecycleError(
      "invalid_version",
      `invalid OIM version: ${manifest.metadata.version}`
    );
  }
  return majorVersion;
}

export function oimMajorStorageSlug(integrationId: string, majorVersion: number): string {
  const slug = `${integrationId}-v${majorVersion}`;
  if (!SOUL_SLUG_PATTERN.test(slug)) {
    throw new OimMajorLifecycleError(
      "invalid_slug",
      `OIM major ${integrationId} v${majorVersion} has no valid Soul artifact slug`
    );
  }
  return slug;
}

export function listOimMajorArtifacts(
  integrations: Iterable<SoulIntegration>
): readonly OimMajorArtifact[] {
  return [...integrations]
    .flatMap((integration): OimMajorArtifact[] => {
      const manifest = integration.oimManifest;
      if (manifest === undefined) return [];
      return [
        {
          slug: integration.slug,
          integrationId: manifest.metadata.id,
          majorVersion: oimManifestMajor(manifest),
          manifest,
        },
      ];
    })
    .sort(
      (left, right) =>
        left.integrationId.localeCompare(right.integrationId) ||
        left.majorVersion - right.majorVersion ||
        left.slug.localeCompare(right.slug)
    );
}

function oneExactMajor(
  artifacts: readonly OimMajorArtifact[],
  integrationId: string,
  majorVersion: number
): OimMajorArtifact | undefined {
  const matches = artifacts.filter(
    (artifact) => artifact.integrationId === integrationId && artifact.majorVersion === majorVersion
  );
  if (matches.length > 1) {
    throw new OimMajorLifecycleError(
      "duplicate_major",
      `OIM integration "${integrationId}" v${majorVersion} is installed more than once`
    );
  }
  return matches[0];
}

/** Resolve only an exact major. Callers must never substitute the newest installed version. */
export function resolveOimMajorArtifact(
  integrations: Iterable<SoulIntegration>,
  identity: { readonly id: string; readonly majorVersion: number }
): OimMajorArtifact | undefined {
  return oneExactMajor(listOimMajorArtifacts(integrations), identity.id, identity.majorVersion);
}

/** An unversioned alias is safe only while exactly one major is installed. */
export function resolveOimUnversionedAlias(
  integrations: Iterable<SoulIntegration>,
  integrationId: string
): OimMajorArtifact | undefined {
  const matches = listOimMajorArtifacts(integrations).filter(
    (artifact) => artifact.integrationId === integrationId
  );
  if (matches.length > 1) {
    throw new OimMajorLifecycleError(
      "ambiguous_alias",
      `OIM integration alias "${integrationId}" is ambiguous across installed major versions`
    );
  }
  return matches[0];
}

/**
 * Keep the first installed major on the historical slug and give later majors a readable suffix.
 *
 * Returning an existing exact-major slug makes ordinary installs same-major updates. A different
 * major gets a distinct artifact and lock key; collisions never become overwrites.
 */
export function resolveOimMajorInstallTarget(
  manifest: OimManifest,
  integrations: Iterable<SoulIntegration>,
  occupiedSlugs: Iterable<string> = []
): OimMajorInstallTarget {
  const installed = [...integrations];
  const artifacts = listOimMajorArtifacts(installed);
  const integrationId = manifest.metadata.id;
  const majorVersion = oimManifestMajor(manifest);
  const exact = oneExactMajor(artifacts, integrationId, majorVersion);
  if (exact !== undefined) {
    return {
      slug: exact.slug,
      integrationId,
      majorVersion,
      disposition: "update",
    };
  }

  if (
    installed.some(
      (integration) =>
        integration.sourceIntegration === integrationId && integration.oimManifest === undefined
    )
  ) {
    throw new OimMajorLifecycleError(
      "format_collision",
      `integration "${integrationId}" cannot change between legacy and OIM formats`
    );
  }

  const hasAnotherMajor = artifacts.some((artifact) => artifact.integrationId === integrationId);
  const slug = hasAnotherMajor ? oimMajorStorageSlug(integrationId, majorVersion) : integrationId;
  if (!SOUL_SLUG_PATTERN.test(slug)) {
    throw new OimMajorLifecycleError(
      "invalid_slug",
      `OIM integration "${integrationId}" has no valid Soul artifact slug`
    );
  }

  const occupied = new Set(occupiedSlugs);
  if (installed.some((integration) => integration.slug === slug) || occupied.has(slug)) {
    throw new OimMajorLifecycleError(
      "slug_collision",
      `integration artifact slug already exists: ${slug}`
    );
  }

  return { slug, integrationId, majorVersion, disposition: "install" };
}

export function oimPinnedToolId(manifest: OimManifest, operationId: string): string {
  return oimToolId(manifest, operationId);
}

export function oimConnectionMatchesManifest(
  connection: Pick<OimConnectionMajorBinding, "integration">,
  manifest: OimManifest
): boolean {
  return (
    connection.integration.id === manifest.metadata.id &&
    connection.integration.majorVersion === oimManifestMajor(manifest)
  );
}

export function requireOimConnectionForManifest<T extends OimConnectionMajorBinding>(
  connection: T,
  manifest: OimManifest
): T {
  if (!oimConnectionMatchesManifest(connection, manifest)) {
    throw new OimMajorLifecycleError(
      "connection_mismatch",
      `Connection "${connection.id}" is not bound to ${manifest.metadata.id} v${oimManifestMajor(
        manifest
      )}`
    );
  }
  return connection;
}
