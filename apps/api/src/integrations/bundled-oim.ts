import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { CommitActor } from "@tulipfarm/soul";
import { bundledIntegrationsDir, type SoulLoader, type SoulWriter } from "@tulipfarm/soul";
import {
  discoverIntegrations,
  IntegrationInstallError,
  packageChanges,
  readIntegrationLock,
  serializeIntegrationLock,
} from "./install";

/**
 * Materializing a bundled OIM package into the Soul.
 *
 * A legacy bundled Integration keeps its manifest in code and puts only `connection.yaml` in the
 * Soul. An OIM package cannot do that: the loader reads `oim.yml` and its content-addressed
 * companions from the Soul, and the Tool compiler reads them from the loader. So connecting a
 * bundled OIM package first copies the whole package in — the same bytes, through the same
 * `packageChanges` the remote installer uses, so a bundled install and a `git` install can never
 * produce different Soul contents for the same package.
 */

/** Provenance for a package that came from the image rather than a repository. */
export const BUNDLED_SOURCE = "bundled";

export interface MaterializeBundledOimDeps {
  readonly soulLoader: SoulLoader;
  readonly soulWriter: SoulWriter;
  readonly actor: CommitActor;
  /** Overridable for tests; defaults to the image's bundled integrations directory. */
  readonly root?: string;
}

/**
 * Copies the bundled OIM package named `slug` into the Soul, if it is not already there.
 *
 * Returns the installed package digest, or `undefined` when no bundled OIM package carries that
 * slug — the caller is then looking at a legacy or third-party entry and should not be told a
 * package was installed.
 */
export async function materializeBundledOimPackage(
  slug: string,
  deps: MaterializeBundledOimDeps
): Promise<string | undefined> {
  if (deps.soulLoader.integrations.has(slug)) return undefined;
  const discovered = await discoverIntegrations(deps.root ?? bundledIntegrationsDir());
  const chosen = discovered.find((entry) => entry.name === slug && entry.oimManifest !== undefined);
  if (chosen === undefined) return undefined;
  if (chosen.issues.length > 0) {
    // A package shipped in our own image that fails its own checks is a build defect, not operator
    // error, so it is reported rather than silently skipped.
    throw new IntegrationInstallError(
      `bundled integration "${slug}" is not installable: ${chosen.issues.join("; ")}`,
      409
    );
  }

  const { changes, hash } = packageChanges(chosen);
  const lock = readIntegrationLock(deps.soulWriter);
  lock.integrations[slug] = {
    sourceType: BUNDLED_SOURCE,
    manifestPath: chosen.manifestPath,
    hash,
    definition: "oim",
    ...(chosen.packageDigest === undefined ? {} : { packageDigest: chosen.packageDigest }),
  };
  changes.push({
    op: "put",
    target: { kind: "IntegrationsLock" },
    content: serializeIntegrationLock(lock),
  });

  await deps.soulWriter.apply({
    subject: `soul: install integration ${slug}`,
    source: "api",
    actor: deps.actor,
    businessId: DEPLOYMENT_BUSINESS_ID,
    changes,
  });
  await deps.soulLoader.reload();
  return chosen.packageDigest;
}
