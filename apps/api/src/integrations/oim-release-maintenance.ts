import { type EgressHttpPort, sendGovernedRequest } from "@tulipfarm/integrations";
import {
  type OimAutoPatchRequest,
  OimReleaseTrustError,
} from "@tulipfarm/integrations/src/releases/trust-service";
import {
  type OimManifest,
  type OimPackageContent,
  oimPackageDigest,
  parseOimManifest,
} from "@tulipfarm/schema";
import type { SoulIntegration } from "@tulipfarm/soul";
import type { InstalledOimReleaseProvenance, OimReleaseTrustStore } from "@tulipfarm/storage";
import { stringify as stringifyYaml } from "yaml";
import { inspectIntegrationSource, type SourceInspection } from "./install";
import { resolveOimMajorArtifact } from "./oim-major-versions";
import type { OimReleaseTrustHost } from "./oim-release-compose";

const MAX_FEED_BYTES = 1024 * 1024;
export const OIM_RELEASE_MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000;

interface ReleaseFeedEntry {
  readonly source: string;
  readonly ref: string;
  readonly signedRelease: unknown;
}

interface ReleaseMaintenanceFeed {
  readonly feedVersion: 1;
  readonly revocations: unknown;
  readonly releases: readonly ReleaseFeedEntry[];
}

export interface ApplyOimPatchInput {
  readonly source: string;
  readonly name: string;
  readonly ref: string;
  readonly signedRelease: unknown;
}

export interface OimReleaseMaintenanceDeps {
  readonly actorId: string;
  readonly businessId: string;
  readonly http: EgressHttpPort;
  readonly integrations: () => Iterable<SoulIntegration>;
  readonly store: Pick<
    OimReleaseTrustStore,
    "getRevocationFeed" | "listAutoPatchProvenance" | "load"
  >;
  readonly releaseTrust: Pick<OimReleaseTrustHost, "acceptRevocationList" | "authorizeAutoPatch">;
  readonly inspectSource?: typeof inspectIntegrationSource;
  readonly applyPatch: (input: ApplyOimPatchInput) => Promise<unknown>;
}

export interface OimReleasePatchMaintenanceResult {
  readonly integrationId: string;
  readonly majorVersion: number;
  readonly status: "failed" | "skipped" | "updated";
  readonly reason?: string;
}

export interface OimReleaseMaintenanceResult {
  readonly feed: "disabled" | "unchanged" | "updated";
  readonly patches: readonly OimReleasePatchMaintenanceResult[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

class OimReleaseMaintenanceSkip extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "OimReleaseMaintenanceSkip";
  }
}

function parseFeed(value: unknown): ReleaseMaintenanceFeed {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["feedVersion", "releases", "revocations"]) ||
    value.feedVersion !== 1 ||
    !isRecord(value.revocations) ||
    !Array.isArray(value.releases) ||
    value.releases.length > 1000
  ) {
    throw new Error("invalid_oim_release_maintenance_feed");
  }
  const releases = value.releases.map((entry) => {
    if (
      !isRecord(entry) ||
      !exactKeys(entry, ["ref", "signedRelease", "source"]) ||
      typeof entry.source !== "string" ||
      entry.source.length === 0 ||
      typeof entry.ref !== "string" ||
      entry.ref.length === 0 ||
      !isRecord(entry.signedRelease)
    ) {
      throw new Error("invalid_oim_release_maintenance_feed");
    }
    return {
      source: entry.source,
      ref: entry.ref,
      signedRelease: entry.signedRelease,
    };
  });
  return {
    feedVersion: 1,
    revocations: value.revocations,
    releases,
  };
}

function responseJson(body: unknown): unknown {
  if (typeof body === "string") {
    if (Buffer.byteLength(body) > MAX_FEED_BYTES) throw new Error("oim_release_feed_too_large");
    return JSON.parse(body);
  }
  if (body instanceof Uint8Array) {
    if (body.byteLength > MAX_FEED_BYTES) throw new Error("oim_release_feed_too_large");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  }
  const encoded = JSON.stringify(body);
  if (encoded === undefined || Buffer.byteLength(encoded) > MAX_FEED_BYTES) {
    throw new Error("oim_release_feed_too_large");
  }
  return body;
}

async function fetchFeed(http: EgressHttpPort, url: string): Promise<ReleaseMaintenanceFeed> {
  const result = await sendGovernedRequest(http, { method: "GET", url });
  if (result.kind === "cross_origin_redirect") {
    throw new Error("oim_release_feed_cross_origin_redirect");
  }
  if (result.kind === "redirect_limit") throw new Error("oim_release_feed_redirect_limit");
  if (result.response.status < 200 || result.response.status >= 300) {
    throw new Error(`oim_release_feed_http_${result.response.status}`);
  }
  return parseFeed(responseJson(result.response.body));
}

function revocationSignature(value: unknown): string | undefined {
  if (
    !isRecord(value) ||
    !isRecord(value.list) ||
    !Number.isSafeInteger(value.list.sequence) ||
    !isRecord(value.signature) ||
    typeof value.signature.keyId !== "string" ||
    typeof value.signature.value !== "string"
  ) {
    return undefined;
  }
  return `${value.list.sequence}:${value.signature.keyId}:${value.signature.value}`;
}

function signedReleaseIdentity(value: unknown) {
  if (
    !isRecord(value) ||
    value.envelopeVersion !== 1 ||
    !isRecord(value.release) ||
    typeof value.release.integrationId !== "string" ||
    typeof value.release.version !== "string" ||
    typeof value.release.packageDigest !== "string"
  ) {
    return undefined;
  }
  return {
    integrationId: value.release.integrationId,
    version: value.release.version,
    packageDigest: value.release.packageDigest,
  };
}

function releasePackage(
  manifest: OimManifest,
  files?: ReadonlyMap<string, OimPackageContent>
): OimAutoPatchRequest["current"]["package"] {
  return { manifest, files: files ?? new Map() };
}

function installedPackage(integration: SoulIntegration): OimAutoPatchRequest["current"]["package"] {
  if (integration.oimManifest === undefined) throw new Error("installed_oim_manifest_missing");
  const files =
    integration.oimPackageFiles === undefined
      ? new Map<string, OimPackageContent>()
      : new Map(Object.entries(integration.oimPackageFiles));
  return releasePackage(integration.oimManifest, files);
}

function candidateFromInspection(
  inspection: SourceInspection,
  provenance: InstalledOimReleaseProvenance
) {
  const currentVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/.exec(provenance.version);
  if (currentVersion === null) throw new Error("installed_oim_version_invalid");
  const currentMajor = Number(currentVersion[1]);
  const currentMinor = Number(currentVersion[2]);
  const currentPatch = Number(currentVersion[3]);
  const candidates = inspection.integrations.filter((candidate) => {
    if (candidate.oimManifest?.metadata.id !== provenance.integrationId) return false;
    const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/.exec(
      candidate.oimManifest.metadata.version
    );
    return (
      version !== null &&
      Number(version[1]) === currentMajor &&
      Number(version[2]) === currentMinor &&
      Number(version[3]) > currentPatch
    );
  });
  if (candidates.length === 0) throw new OimReleaseMaintenanceSkip("no_eligible_patch");
  const highestPatch = Math.max(
    ...candidates.map((candidate) =>
      Number(candidate.oimManifest?.metadata.version.split(".")[2]?.split("-", 1)[0])
    )
  );
  const highest = candidates.filter(
    (candidate) =>
      Number(candidate.oimManifest?.metadata.version.split(".")[2]?.split("-", 1)[0]) ===
      highestPatch
  );
  const candidate = highest[0];
  if (highest.length !== 1 || candidate?.oimManifest === undefined) {
    throw new Error("oim_patch_candidate_ambiguous");
  }
  return {
    package: releasePackage(candidate.oimManifest, candidate.companions),
    ref: inspection.ref,
    source: inspection.source,
  };
}

function matchingRelease(
  feed: ReleaseMaintenanceFeed,
  candidate: ReturnType<typeof candidateFromInspection>
): ReleaseFeedEntry | undefined {
  const digest = oimPackageDigest(candidate.package.manifest);
  const matches = feed.releases.filter((release) => {
    const identity = signedReleaseIdentity(release.signedRelease);
    return (
      release.source === candidate.source &&
      release.ref === candidate.ref &&
      identity?.integrationId === candidate.package.manifest.metadata.id &&
      identity.version === candidate.package.manifest.metadata.version &&
      identity.packageDigest === digest
    );
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function originalRequirements(provenance: InstalledOimReleaseProvenance): OimManifest {
  return parseOimManifest(stringifyYaml(provenance.originalRequirements));
}

function reason(error: unknown): string {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return error instanceof Error ? error.message : "maintenance_failed";
}

const POLICY_SKIP_CODES = new Set([
  "AUTO_PATCH_NOT_ALLOWED",
  "COMMUNITY_DIGEST_APPROVAL_REQUIRED",
  "RELEASE_IDENTITY_MISMATCH",
  "RELEASE_REVOKED",
  "RELEASE_SIGNATURE_INVALID",
  "RELEASE_SIGNER_UNKNOWN",
]);

async function maintainPatch(
  deps: OimReleaseMaintenanceDeps,
  feed: ReleaseMaintenanceFeed,
  provenance: InstalledOimReleaseProvenance
): Promise<OimReleasePatchMaintenanceResult> {
  try {
    const integrations = [...deps.integrations()];
    const artifact = resolveOimMajorArtifact(integrations, {
      id: provenance.integrationId,
      majorVersion: provenance.majorVersion,
    });
    if (artifact === undefined) throw new Error("installed_oim_major_missing");
    const integration = integrations.find((entry) => entry.slug === artifact.slug);
    if (integration === undefined) throw new Error("installed_oim_major_missing");
    const inspection = await (deps.inspectSource ?? inspectIntegrationSource)(
      provenance.source,
      deps.actorId,
      { http: deps.http }
    );
    const candidate = candidateFromInspection(inspection, provenance);
    const release = matchingRelease(feed, candidate);
    if (release === undefined) {
      return {
        integrationId: provenance.integrationId,
        majorVersion: provenance.majorVersion,
        status: "skipped",
        reason: "signed_release_missing",
      };
    }
    if (provenance.signedRelease === undefined) throw new Error("installed_signature_missing");
    await deps.releaseTrust.authorizeAutoPatch({
      optedIn: provenance.autoPatchOptIn,
      originalRequirements: originalRequirements(provenance),
      current: {
        package: installedPackage(integration),
        signedRelease: provenance.signedRelease,
      },
      candidate: {
        package: candidate.package,
        signedRelease: release.signedRelease,
      },
    });
    await deps.applyPatch({
      source: candidate.source,
      name: artifact.slug,
      ref: candidate.ref,
      signedRelease: release.signedRelease,
    });
    return {
      integrationId: provenance.integrationId,
      majorVersion: provenance.majorVersion,
      status: "updated",
    };
  } catch (error) {
    const skipped =
      error instanceof OimReleaseMaintenanceSkip ||
      (error instanceof OimReleaseTrustError && POLICY_SKIP_CODES.has(error.code));
    return {
      integrationId: provenance.integrationId,
      majorVersion: provenance.majorVersion,
      status: skipped ? "skipped" : "failed",
      reason: error instanceof OimReleaseMaintenanceSkip ? error.reason : reason(error),
    };
  }
}

/** Refreshes signed revocations, then applies enabled trusted patch releases. */
export async function runOimReleaseMaintenance(
  deps: OimReleaseMaintenanceDeps
): Promise<OimReleaseMaintenanceResult> {
  const configuredFeed = await deps.store.getRevocationFeed();
  if (configuredFeed === null) return { feed: "disabled", patches: [] };
  const feed = await fetchFeed(deps.http, configuredFeed.url);
  const current = await deps.store.load();
  const unchanged =
    revocationSignature(current) !== undefined &&
    revocationSignature(current) === revocationSignature(feed.revocations);
  if (!unchanged) await deps.releaseTrust.acceptRevocationList(feed.revocations);

  const provenance = await deps.store.listAutoPatchProvenance(deps.businessId);
  const patches: OimReleasePatchMaintenanceResult[] = [];
  for (const installed of provenance) {
    patches.push(await maintainPatch(deps, feed, installed));
  }
  return { feed: unchanged ? "unchanged" : "updated", patches };
}

export class OimReleaseMaintenanceWorker {
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;

  constructor(
    private readonly deps: OimReleaseMaintenanceDeps,
    private readonly log: { error(message: string): void },
    private readonly intervalMs = OIM_RELEASE_MAINTENANCE_INTERVAL_MS
  ) {}

  start(): void {
    if (this.#timer !== undefined) return;
    void this.#tick();
    this.#timer = setInterval(() => void this.#tick(), this.intervalMs);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  async runOnce(): Promise<OimReleaseMaintenanceResult> {
    const result = await runOimReleaseMaintenance(this.deps);
    for (const patch of result.patches) {
      if (patch.status === "failed") {
        this.log.error(
          `[oim-release-maintenance] ${patch.integrationId} v${patch.majorVersion}: ${patch.reason ?? "maintenance_failed"}`
        );
      }
    }
    return result;
  }

  async #tick(): Promise<void> {
    if (this.#running !== undefined) return;
    this.#running = this.runOnce()
      .then(() => undefined)
      .catch((error) => {
        this.log.error(
          `[oim-release-maintenance] ${error instanceof Error ? error.message : String(error)}`
        );
      })
      .finally(() => {
        this.#running = undefined;
      });
    await this.#running;
  }
}
