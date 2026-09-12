import { type OimConnection, type OimManifest, oimPackageDigest } from "@tulipfarm/schema";

export interface OimPackageCatalogEntry {
  readonly key: string;
  readonly manifest: OimManifest;
  /** Digest of the reviewed package, including companion files when the host has them. */
  readonly packageDigest?: string;
}

export interface ResolvedOimPackage extends OimPackageCatalogEntry {
  readonly identity: OimConnection["integration"];
  readonly packageDigest: string;
}

export function oimManifestMajor(manifest: Pick<OimManifest, "metadata">): number {
  const match = /^(0|[1-9]\d*)\./.exec(manifest.metadata.version);
  const majorVersion = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(majorVersion)) {
    throw new Error(`invalid OIM version: ${manifest.metadata.version}`);
  }
  return majorVersion;
}

/**
 * Resolves only an authoritative catalog key.
 *
 * Keys are opaque: `acme-v2` may mean major 2 of `acme`, or major 1 of an Integration whose real
 * id is `acme-v2`. Only the catalog can answer that safely.
 */
export function resolveOimPackage(
  entries: Iterable<OimPackageCatalogEntry>,
  key: string
): ResolvedOimPackage | undefined {
  const matches = [...entries].filter((entry) => entry.key === key);
  if (matches.length > 1) throw new Error(`duplicate OIM catalog key: ${key}`);
  const entry = matches[0];
  if (entry === undefined) return undefined;
  return {
    ...entry,
    identity: {
      id: entry.manifest.metadata.id,
      majorVersion: oimManifestMajor(entry.manifest),
    },
    packageDigest: entry.packageDigest ?? oimPackageDigest(entry.manifest),
  };
}

export function connectionMatchesPackage(
  connection: Pick<OimConnection, "integration">,
  entry: ResolvedOimPackage
): boolean {
  return (
    connection.integration.id === entry.identity.id &&
    connection.integration.majorVersion === entry.identity.majorVersion
  );
}
