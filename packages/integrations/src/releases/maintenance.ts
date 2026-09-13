import { oimPackageDigest } from "@tulipfarm/schema";
import type {
  InstalledOimReleaseProvenance,
  PersistedInstalledOimReleaseProvenance,
} from "@tulipfarm/storage";
import {
  type OimReleaseCandidate,
  type OimReleaseSelection,
  selectOimReleaseCandidate,
} from "./candidates";
import { applyAuthorizedOimReleasePatch, type InstallSelectedOimReleaseDeps } from "./installer";
import type { OimReleasePackage } from "./package-verifier";
import { parseSignedOimRelease } from "./signatures";
import type { AuthorizedOimAutoPatch } from "./trust-service";

export interface OimReleaseFeedEntry {
  readonly source: string;
  readonly ref: string;
  readonly signedRelease: unknown;
}

export interface OimReleaseMaintenanceFeed {
  readonly feedVersion: 1;
  readonly revocations: unknown;
  readonly releases: readonly OimReleaseFeedEntry[];
}

export interface OimReleaseMaintenanceTrustPort {
  updateRevocationList(input: unknown): Promise<unknown>;
  recordKnownSignedReleases(inputs: readonly unknown[]): Promise<void>;
  listAutoPatchProvenance(
    businessId: string
  ): Promise<readonly PersistedInstalledOimReleaseProvenance[]>;
  selectAutoPatch(input: {
    readonly businessId: string;
    readonly integrationId: string;
    readonly majorVersion: number;
    readonly currentPackage: OimReleasePackage;
    readonly selection: OimReleaseSelection;
    readonly candidates: readonly OimReleaseCandidate[];
  }): Promise<AuthorizedOimAutoPatch>;
}

export interface OimReleaseMaintenanceDeps {
  readonly businessId: string;
  readonly trust: OimReleaseMaintenanceTrustPort;
  readonly installedPackage: (
    provenance: InstalledOimReleaseProvenance
  ) => Promise<OimReleasePackage>;
  /** Inspects exactly `ref`; resolving a branch or current HEAD instead must fail closed. */
  readonly inspectSource: (
    source: string,
    ref: string
  ) => Promise<{
    readonly ref: string;
    readonly candidates: readonly (OimReleaseCandidate & { readonly sourcePath: string })[];
  }>;
  readonly patch: InstallSelectedOimReleaseDeps;
}

export interface OimReleasePatchMaintenanceResult {
  readonly integrationId: string;
  readonly majorVersion: number;
  readonly status: "failed" | "skipped" | "updated";
  readonly version?: string;
  readonly reason?: string;
}

export interface OimReleaseMaintenanceResult {
  readonly revocations: "unchanged" | "updated";
  readonly patches: readonly OimReleasePatchMaintenanceResult[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

function parseFeed(input: unknown): OimReleaseMaintenanceFeed {
  if (
    !record(input) ||
    !exactKeys(input, ["feedVersion", "releases", "revocations"]) ||
    input.feedVersion !== 1 ||
    !record(input.revocations) ||
    !Array.isArray(input.releases) ||
    input.releases.length > 1000
  ) {
    throw new Error("invalid_oim_release_feed");
  }
  const releases = input.releases.map((entry) => {
    if (
      !record(entry) ||
      !exactKeys(entry, ["ref", "signedRelease", "source"]) ||
      typeof entry.source !== "string" ||
      entry.source.length === 0 ||
      typeof entry.ref !== "string" ||
      entry.ref.length === 0 ||
      !record(entry.signedRelease)
    ) {
      throw new Error("invalid_oim_release_feed");
    }
    return {
      source: entry.source,
      ref: entry.ref,
      signedRelease: entry.signedRelease,
    };
  });
  return Object.freeze({
    feedVersion: 1,
    revocations: input.revocations,
    releases: Object.freeze(releases),
  });
}

function versionParts(version: string): readonly [number, number, number] | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+].+)?$/.exec(version);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function releaseFor(
  feed: OimReleaseMaintenanceFeed,
  provenance: InstalledOimReleaseProvenance
): { readonly entry: OimReleaseFeedEntry; readonly selection: OimReleaseSelection } | undefined {
  if (provenance.source.kind !== "git") return undefined;
  const current = versionParts(provenance.version);
  if (current === undefined) throw new Error("installed_oim_version_invalid");
  const eligible: {
    readonly entry: OimReleaseFeedEntry;
    readonly selection: OimReleaseSelection;
    readonly patch: number;
  }[] = [];
  for (const entry of feed.releases) {
    let signed: ReturnType<typeof parseSignedOimRelease>;
    try {
      signed = parseSignedOimRelease(entry.signedRelease);
    } catch {
      continue;
    }
    const next = versionParts(signed.release.version);
    if (
      entry.source !== provenance.source.repository ||
      signed.release.integrationId !== provenance.integrationId ||
      next === undefined ||
      next[0] !== current[0] ||
      next[1] !== current[1] ||
      next[2] <= current[2]
    ) {
      continue;
    }
    eligible.push({
      entry,
      selection: {
        integrationId: signed.release.integrationId,
        version: signed.release.version,
        packageDigest: signed.release.packageDigest,
      },
      patch: next[2],
    });
  }
  if (eligible.length === 0) return undefined;
  const highestPatch = Math.max(...eligible.map((candidate) => candidate.patch));
  const highest = eligible.filter((candidate) => candidate.patch === highestPatch);
  if (highest.length !== 1) throw new Error("release_feed_candidate_ambiguous");
  return highest[0];
}

function reason(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return error instanceof Error ? error.message : "release_maintenance_failed";
}

export async function runOimReleaseMaintenance(
  feedInput: unknown,
  deps: OimReleaseMaintenanceDeps
): Promise<OimReleaseMaintenanceResult> {
  const feed = parseFeed(feedInput);
  let revocations: "unchanged" | "updated" = "updated";
  try {
    await deps.trust.updateRevocationList(feed.revocations);
  } catch (error) {
    if (reason(error) !== "REVOCATION_REPLAY") throw error;
    revocations = "unchanged";
  }
  await deps.trust.recordKnownSignedReleases(
    feed.releases.map(({ signedRelease }) => signedRelease)
  );

  const installed = await deps.trust.listAutoPatchProvenance(deps.businessId);
  const patches: OimReleasePatchMaintenanceResult[] = [];
  for (const provenance of installed) {
    try {
      const release = releaseFor(feed, provenance);
      if (release === undefined) {
        patches.push({
          integrationId: provenance.integrationId,
          majorVersion: provenance.majorVersion,
          status: "skipped",
          reason: "no_eligible_patch",
        });
        continue;
      }
      const inspected = await deps.inspectSource(release.entry.source, release.entry.ref);
      const candidates = inspected.candidates.map((candidate) =>
        candidate.package.manifest.metadata.id === release.selection.integrationId &&
        candidate.package.manifest.metadata.version === release.selection.version &&
        oimPackageDigest(candidate.package.manifest) === release.selection.packageDigest
          ? { ...candidate, signedRelease: release.entry.signedRelease }
          : candidate
      );
      const selectedCandidate = selectOimReleaseCandidate(release.selection, candidates);
      const selected = candidates.find((candidate) => candidate === selectedCandidate);
      if (selected === undefined) throw new Error("release_candidate_path_missing");
      const currentPackage = await deps.installedPackage(provenance);
      const authorization = await deps.trust.selectAutoPatch({
        businessId: provenance.businessId,
        integrationId: provenance.integrationId,
        majorVersion: provenance.majorVersion,
        currentPackage,
        selection: release.selection,
        candidates,
      });
      const applied = await applyAuthorizedOimReleasePatch(
        {
          provenance,
          source: release.entry.source,
          sourceRef: inspected.ref,
          candidatePath: selected.sourcePath,
          selection: release.selection,
          candidates,
          authorization,
        },
        deps.patch
      );
      if (applied.status === "skipped") {
        patches.push({
          integrationId: provenance.integrationId,
          majorVersion: provenance.majorVersion,
          status: "skipped",
          reason: applied.reason,
        });
        continue;
      }
      patches.push({
        integrationId: provenance.integrationId,
        majorVersion: provenance.majorVersion,
        status: "updated",
        version: release.selection.version,
      });
    } catch (error) {
      patches.push({
        integrationId: provenance.integrationId,
        majorVersion: provenance.majorVersion,
        status: "failed",
        reason: reason(error),
      });
    }
  }
  return Object.freeze({ revocations, patches: Object.freeze(patches) });
}
