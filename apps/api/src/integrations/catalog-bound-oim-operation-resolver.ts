import {
  type ConnectionResolver,
  type OimOperationConnectionRequest,
  OimOperationConnectionResolver,
  type OimPackageCatalogEntry,
  oimManifestMajor,
  type ToolConnectionBinding,
} from "@tulipfarm/integrations";
import { type OimManifest, type OimOperation, oimPackageDigest } from "@tulipfarm/schema";
import type { PersistedConnection } from "@tulipfarm/storage";
import type { OimPackageCatalogReader } from "./oim-catalog";

type ConnectionAuthSteps = ConstructorParameters<typeof OimOperationConnectionResolver>[1];

function exactAuthorizedPackage(
  catalog: readonly OimPackageCatalogEntry[],
  manifest: OimManifest
): boolean {
  const matches = catalog.filter(
    (entry) =>
      entry.manifest.metadata.id === manifest.metadata.id &&
      oimManifestMajor(entry.manifest) === oimManifestMajor(manifest)
  );
  if (matches.length !== 1) return false;

  const [entry] = matches;
  if (entry === undefined) return false;
  const requestedDigest = oimPackageDigest(manifest);
  return (
    oimPackageDigest(entry.manifest) === requestedDigest &&
    (entry.packageDigest ?? oimPackageDigest(entry.manifest)) === requestedDigest
  );
}

/**
 * Keeps Connection selection and reauthorization bound to one current reviewed package.
 *
 * The callback is evaluated for every check so a later unified catalog can replace the bundled
 * catalog without caching mutable package authority inside a request host.
 */
export class CatalogBoundOimOperationConnectionResolver extends OimOperationConnectionResolver {
  constructor(
    connections: ConnectionResolver,
    authSteps: ConnectionAuthSteps,
    private readonly catalog: OimPackageCatalogReader,
    now?: () => Date
  ) {
    super(connections, authSteps, now);
  }

  override async resolve(request: OimOperationConnectionRequest) {
    if (!exactAuthorizedPackage(this.catalog(), request.manifest)) {
      return { kind: "connection_denied" as const, reason: "not_found" as const };
    }
    const resolution = await super.resolve(request);
    return exactAuthorizedPackage(this.catalog(), request.manifest)
      ? resolution
      : { kind: "connection_denied" as const, reason: "not_found" as const };
  }

  override async reauthorize(
    businessId: string,
    manifest: OimManifest,
    binding: ToolConnectionBinding,
    credentialRef: `secret://${string}`
  ): Promise<boolean> {
    if (!exactAuthorizedPackage(this.catalog(), manifest)) return false;
    const authorized = await super.reauthorize(businessId, manifest, binding, credentialRef);
    return authorized && exactAuthorizedPackage(this.catalog(), manifest);
  }

  override async reauthorizeConnection(
    businessId: string,
    manifest: OimManifest,
    operation: OimOperation,
    binding: ToolConnectionBinding,
    credentialRef?: `secret://${string}`
  ): Promise<PersistedConnection | null> {
    if (!exactAuthorizedPackage(this.catalog(), manifest)) return null;
    const connection = await super.reauthorizeConnection(
      businessId,
      manifest,
      operation,
      binding,
      credentialRef
    );
    return connection !== null && exactAuthorizedPackage(this.catalog(), manifest)
      ? connection
      : null;
  }
}
