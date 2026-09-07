import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import {
  type EgressHttpPort,
  FetchEgressHttp,
  GuardedEgressHttp,
  gitSourceHttpError,
  type OimFixtureResult,
  type OimPackageAuthorization,
  type OimPackageAuthorizationInput,
  runOimFixtures,
  splitGitSourceRef,
  withGitSourceClone,
} from "@tulipfarm/integrations";
import {
  type OimManifest,
  oimCompatibilityIssues,
  oimPackageDigest,
  oimPackageIssues,
  parseOimManifest,
} from "@tulipfarm/schema";
import {
  type CommitActor,
  type IntegrationManifest,
  type SoulIntegration,
  type SoulLoader,
  type SoulWrite,
  type SoulWriteRequest,
  type SoulWriter,
  sourceType,
  validateAuthSteps,
  validateThirdPartyManifest,
} from "@tulipfarm/soul";
import type { InstalledOimReleaseProvenance } from "@tulipfarm/storage";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { stripUrlCredentials } from "../audit/soul-write";
import { SYSTEM_SOUL_COMMIT_ACTOR } from "../runtime/soul-writer";
import { fetchDirectOimPackage, isDirectOimSource } from "./oim-distribution";
import {
  OimMajorLifecycleError,
  oimManifestMajor,
  resolveOimMajorArtifact,
  resolveOimMajorInstallTarget,
  resolveOimUnversionedAlias,
} from "./oim-major-versions";

/** Installs only declarative Integration artifacts from git; no executable payloads. */

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_FILE_BYTES = 512 * 1024;
/** OpenAPI specs get a larger cap because provider documents are generated. */
const MAX_SPEC_BYTES = 2 * 1024 * 1024;

export interface DiscoveredIntegration {
  /** Directory name in the source repo, which becomes the install slug. */
  name: string;
  /** Absent for an OIM package, which declares itself entirely in `oimManifest`. */
  manifest?: IntegrationManifest;
  /**
   * An Open Integration Manifest, when the directory holds `oim.yml`.
   *
   * The two are mutually exclusive by construction: a directory declaring both is reported as
   * uninstallable rather than resolved in favour of one, because two declarations give two answers
   * about what a single Tool may do.
   */
  oimManifest?: OimManifest;
  setupGuide?: string;
  /** OpenAPI spec carried verbatim beside its Integration manifest. */
  egressSpec?: { file: string; raw: string };
  /** Every file an OIM manifest declares, keyed by its manifest-relative path. */
  companions?: ReadonlyMap<string, string>;
  /** Results from this package's offline fixture companions. */
  fixtureResults?: readonly OimFixtureResult[];
  /**
   * Content address of the whole OIM package, including each declared companion's digest.
   *
   * This is the value an administrator approves. Approving a repository or a ref would inherit
   * whatever that ref points at next; approving the digest cannot.
   */
  packageDigest?: string;
  /** Path of the manifest relative to the repo root, recorded for provenance. */
  manifestPath: string;
  /** Reasons this integration cannot be installed from an untrusted source; empty means safe. */
  issues: string[];
}

export class IntegrationInstallError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 429
  ) {
    super(message);
    this.name = "IntegrationInstallError";
  }
}

function manifestIssues(manifest: IntegrationManifest): string[] {
  const issues: string[] = [];
  if (!manifest.egress?.type) {
    issues.push("egress.type missing");
  } else if (manifest.egress.type === "mcp" && !manifest.egress.entry?.transport) {
    issues.push("egress.entry.transport missing");
  }
  // Validate connect flows before files land, not on next boot.
  issues.push(...validateAuthSteps(manifest));
  issues.push(...validateThirdPartyManifest(manifest));
  return issues;
}

/** Reads required OpenAPI specs strictly; install must fail before copying partial artifacts. */
async function readEgressSpec(
  dir: string,
  entries: Dirent[],
  manifest: IntegrationManifest
): Promise<{ value?: { file: string; raw: string }; issues: string[] }> {
  if (manifest.egress?.type !== "openapi") return { issues: [] };

  const file = basename(manifest.egress.spec ?? "");
  if (!file || !entries.some((sibling) => sibling.name === file && sibling.isFile())) {
    return { issues: [`egress.spec not found next to the manifest: ${manifest.egress.spec}`] };
  }

  const raw = await readFile(join(dir, file), "utf8");
  if (Buffer.byteLength(raw) > MAX_SPEC_BYTES) {
    return { issues: [`egress.spec exceeds ${MAX_SPEC_BYTES} bytes: ${file}`] };
  }
  try {
    // JSON is valid YAML, so this covers both the .json and .yaml specs providers publish.
    parseYaml(raw);
  } catch (error) {
    return {
      issues: [`egress.spec is not valid YAML or JSON: ${file} (${errorMessage(error)})`],
    };
  }
  return { value: { file, raw }, issues: [] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Files an unsigned package may never carry, whatever a manifest declares.
 *
 * A Community package is declarative-only, and these are the ways a repository would otherwise
 * smuggle execution past that promise: a hook or any other script, a dependency manifest that an
 * install step would resolve, or a lockfile implying one ran.
 */
const EXECUTABLE_FILENAMES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "requirements.txt",
  "pyproject.toml",
  "Dockerfile",
]);
const EXECUTABLE_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".py", ".sh", ".rb", ".wasm"];

function executablePayloadIssues(names: Iterable<string>): string[] {
  const issues: string[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    if (
      EXECUTABLE_FILENAMES.has(name) ||
      EXECUTABLE_EXTENSIONS.some((extension) => lower.endsWith(extension))
    ) {
      issues.push(`package carries an executable payload: ${name}`);
    }
  }
  return issues;
}

/**
 * Reads exactly the companion files an OIM manifest declares.
 *
 * Undeclared siblings are deliberately not read: `oimPackageIssues` rejects a package whose files
 * and declarations disagree, and it can only do that if this reads the declared set rather than
 * whatever happens to be next to the manifest.
 */
async function readOimCompanions(
  dir: string,
  manifest: OimManifest
): Promise<{ companions: Map<string, string>; issues: string[] }> {
  const companions = new Map<string, string>();
  const issues: string[] = [];
  for (const file of manifest.files ?? []) {
    const segments = safeCompanionSegments(file.path);
    if (segments === undefined) {
      issues.push(`files: ${file.path} must stay within the package directory`);
      continue;
    }
    const full = join(dir, ...segments);
    let current = dir;
    let regular = true;
    for (const [index, segment] of segments.entries()) {
      current = join(current, segment);
      const info = await lstat(current).catch(() => undefined);
      if (
        info === undefined ||
        info.isSymbolicLink() ||
        (index === segments.length - 1 ? !info.isFile() : !info.isDirectory())
      ) {
        regular = false;
        break;
      }
    }
    if (!regular) {
      issues.push(`files: ${file.path} is declared but missing`);
      continue;
    }
    const raw = await readFile(full, "utf8");
    if (Buffer.byteLength(raw) > MAX_SPEC_BYTES) {
      issues.push(`files: ${file.path} exceeds ${MAX_SPEC_BYTES} bytes`);
      continue;
    }
    companions.set(file.path, raw);
  }
  return { companions, issues };
}

function safeCompanionSegments(path: string): string[] | undefined {
  const segments = path.split("/");
  return segments.length > 0 &&
    segments.every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
    !path.includes("\\")
    ? segments
    : undefined;
}

/** Reads one `oim.yml` directory into a discovery entry, or reports why it cannot be installed. */
async function discoverOimPackage(
  root: string,
  dir: string,
  name: string,
  entries: readonly Dirent[],
  full: string
): Promise<DiscoveredIntegration | undefined> {
  const raw = await readFile(full, "utf8");
  if (Buffer.byteLength(raw) > MAX_FILE_BYTES) return undefined;

  let oimManifest: OimManifest;
  try {
    oimManifest = parseOimManifest(raw);
  } catch (error) {
    return {
      name,
      manifestPath: relative(root, full),
      issues: [`oim.yml is not a valid manifest: ${errorMessage(error)}`],
    };
  }
  const resolvedName = name === "" ? oimManifest.metadata.id : name;
  const base: Omit<DiscoveredIntegration, "issues"> = {
    name: resolvedName,
    manifestPath: relative(root, full),
  };
  if (!NAME_RE.test(resolvedName)) {
    return { ...base, issues: [`integration id is not a safe install name: ${resolvedName}`] };
  }
  if (entries.some((sibling) => sibling.name === "manifest.yml" && sibling.isFile())) {
    return { ...base, issues: ["declares both oim.yml and manifest.yml; keep exactly one"] };
  }

  const { companions, issues: companionIssues } = await readOimCompanions(dir, oimManifest);
  let setupGuide: string | undefined;
  if (entries.some((sibling) => sibling.name === "setup-guide.md" && sibling.isFile())) {
    const guide = await readFile(join(dir, "setup-guide.md"), "utf8");
    if (Buffer.byteLength(guide) <= MAX_FILE_BYTES) setupGuide = guide;
  }

  // Stated as its own refusal rather than left to the file checks: a manifest declaring hooks is
  // asking for code to run inside TulipFarm, and an author deserves that answer even when the
  // JavaScript it names is absent from the package.
  const hookIssues =
    (oimManifest.hooks ?? []).length > 0
      ? ["hooks: an unsigned package may not declare JavaScript hooks"]
      : [];
  const fixtureResults = await runOimFixtures(oimManifest, companions);

  return {
    ...base,
    oimManifest,
    companions,
    packageDigest: oimPackageDigest(oimManifest),
    ...(setupGuide === undefined ? {} : { setupGuide }),
    issues: [
      ...executablePayloadIssues([
        ...entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
        ...(oimManifest.files ?? []).map((file) => file.path),
      ]),
      ...hookIssues,
      ...companionIssues,
      ...oimPackageIssues(oimManifest, companions),
      ...fixtureResults
        .filter((fixture) => !fixture.passed)
        .map((fixture) => `fixture ${fixture.name} failed: ${fixture.error}`),
    ],
    ...(fixtureResults.length === 0 ? {} : { fixtureResults }),
  };
}

/** Discovers manifest directories whose names match their declared slugs. */
export async function discoverIntegrations(root: string): Promise<DiscoveredIntegration[]> {
  const found: DiscoveredIntegration[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 6) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      // Dirent lstat skips symlinks, so links outside the clone are never read or descended into.
      if (!entry.isFile()) continue;
      if (entry.name !== "manifest.yml" && entry.name !== "oim.yml") continue;

      const name = dir === root ? "" : (dir.split(/[\\/]/).pop() ?? "");
      if (name !== "" && !NAME_RE.test(name)) continue;

      if (entry.name === "oim.yml") {
        const discovered = await discoverOimPackage(root, dir, name, entries, full);
        if (discovered !== undefined) found.push(discovered);
        continue;
      }

      // A directory declaring both formats is reported once, by the OIM branch above. Reading it
      // again as a legacy manifest would offer the caller two entries for one directory, one of
      // them installable.
      if (entries.some((sibling) => sibling.name === "oim.yml" && sibling.isFile())) continue;

      const raw = await readFile(full, "utf8");
      if (Buffer.byteLength(raw) > MAX_FILE_BYTES) continue;

      let manifest: IntegrationManifest;
      try {
        manifest = (parseYaml(raw) ?? {}) as IntegrationManifest;
      } catch {
        continue;
      }
      if (typeof manifest !== "object" || manifest === null) continue;
      const resolvedName = name === "" && typeof manifest.name === "string" ? manifest.name : name;
      if (!NAME_RE.test(resolvedName)) continue;

      // Never follow setup-guide symlinks; the guide is committed to the operator's Soul repo.
      let setupGuide: string | undefined;
      if (entries.some((sibling) => sibling.name === "setup-guide.md" && sibling.isFile())) {
        const guide = await readFile(join(dir, "setup-guide.md"), "utf8");
        if (Buffer.byteLength(guide) <= MAX_FILE_BYTES) setupGuide = guide;
      }

      const spec = await readEgressSpec(dir, entries, manifest);

      found.push({
        name: resolvedName,
        manifest,
        setupGuide,
        egressSpec: spec.value,
        manifestPath: relative(root, full),
        issues: [...manifestIssues(manifest), ...spec.issues],
      });
    }
  }

  await walk(root, 0);
  return found.sort((left, right) => left.name.localeCompare(right.name));
}

export interface IntegrationLockEntry {
  sourceUrl?: string;
  sourceType?: string;
  manifestPath?: string;
  ref?: string;
  hash?: string;
  /** Which declaration format was installed; absent means the legacy `manifest.yml`. */
  definition?: "oim";
  /**
   * The OIM package digest an administrator approved.
   *
   * An update whose digest differs is a different grant of authority than the one approved, so it
   * is refused until the new digest is named explicitly. Recording the source and ref instead
   * would approve whatever that ref points at next.
   */
  packageDigest?: string;
  /** Stable manifest identity, which may differ from the storage slug for side-by-side majors. */
  integrationId?: string;
  /** Installed major used to find the source package and bind durable provenance. */
  majorVersion?: number;
}

export function readIntegrationLock(soulWriter: Pick<SoulWriter, "read">): {
  version: number;
  integrations: Record<string, IntegrationLockEntry>;
} {
  const raw = soulWriter.read("IntegrationsLock");
  if (raw === null) return { version: 1, integrations: {} };
  try {
    const parsed = JSON.parse(raw) as {
      version?: number;
      integrations?: Record<string, IntegrationLockEntry>;
    };
    return { version: parsed.version ?? 1, integrations: parsed.integrations ?? {} };
  } catch {
    return { version: 1, integrations: {} };
  }
}

/** Serialize the lock for a `IntegrationsLock` changeset entry — the writer never touches disk itself. */
export function serializeIntegrationLock(lock: {
  version: number;
  integrations: Record<string, IntegrationLockEntry>;
}): string {
  return `${JSON.stringify(lock, null, 2)}\n`;
}

export interface InstallResult {
  name: string;
  source: string;
  ref: string;
  integrationId?: string;
  majorVersion?: number;
  support?: "official" | "community";
  /** Present for an OIM package: the exact bytes now installed. */
  packageDigest?: string;
}

export interface RemoveResult {
  name: string;
  integrationId?: string;
  majorVersion?: number;
}

export interface OimInstallTrust {
  authorizeInstall(input: OimPackageAuthorizationInput): Promise<OimPackageAuthorization>;
  installedProvenance(
    businessId: string,
    integrationId: string,
    majorVersion: number
  ): Promise<InstalledOimReleaseProvenance | null>;
  recordInstalledProvenance(input: {
    readonly authorization: OimPackageAuthorization;
    readonly businessId: string;
    readonly source: string;
    readonly originalRequirements: OimManifest;
    readonly autoPatchOptIn: boolean;
  }): Promise<void>;
}

export interface SourceInspection {
  /** Credential-free provenance safe to return and persist. */
  source: string;
  sourceType: "github" | "git" | "https";
  /** Git commit or content-addressed HTTPS package reference. */
  ref: string;
  integrations: DiscoveredIntegration[];
}

function safeGitSource(source: string): string {
  const { base, ref } = splitGitSourceRef(source);
  let safeBase = stripUrlCredentials(base);
  try {
    const url = new URL(safeBase);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    safeBase = url.toString();
  } catch {
    // Shorthand sources carry no query or userinfo and are safe verbatim.
  }
  return ref === undefined ? safeBase : `${safeBase}#${ref}`;
}

function directHttp(): EgressHttpPort {
  return new GuardedEgressHttp(
    new FetchEgressHttp({ maxResponseBytes: MAX_SPEC_BYTES, timeoutMs: 30_000 })
  );
}

function oimReleasePackage(chosen: DiscoveredIntegration): OimPackageAuthorizationInput["package"] {
  if (chosen.oimManifest === undefined) {
    throw new IntegrationInstallError("release authorization requires an OIM package", 400);
  }
  return { manifest: chosen.oimManifest, files: chosen.companions ?? new Map() };
}

function hookFilePaths(manifest: OimManifest): ReadonlySet<string> {
  return new Set((manifest.hooks ?? []).map((hook) => hook.file));
}

function authorizedIssues(
  chosen: DiscoveredIntegration,
  authorization: OimPackageAuthorization
): readonly string[] {
  if (!authorization.hooksAllowed || chosen.oimManifest === undefined) return chosen.issues;
  const hooks = hookFilePaths(chosen.oimManifest);
  return chosen.issues.filter(
    (issue) =>
      issue !== "hooks: an unsigned package may not declare JavaScript hooks" &&
      ![...hooks].some((path) => issue === `package carries an executable payload: ${path}`)
  );
}

function requireOfficialAutoPatch(
  authorization: OimPackageAuthorization,
  autoPatchOptIn: boolean | undefined
): void {
  if (autoPatchOptIn === true && authorization.trustClass !== "official") {
    throw new IntegrationInstallError(
      "automatic patch updates require a verified Official release",
      409
    );
  }
}

async function authorizeOimInstall(
  chosen: DiscoveredIntegration,
  input: {
    readonly approvedCommunityDigest?: string;
    readonly signedRelease?: unknown;
  },
  trust?: OimInstallTrust
): Promise<OimPackageAuthorization> {
  if (chosen.oimManifest === undefined || chosen.packageDigest === undefined) {
    throw new IntegrationInstallError("release authorization requires an OIM package", 400);
  }
  if (trust === undefined) {
    if (input.signedRelease !== undefined) {
      throw new IntegrationInstallError(
        "signed OIM releases require the configured release trust service",
        409
      );
    }
    if (input.approvedCommunityDigest !== chosen.packageDigest) {
      throw new IntegrationInstallError(
        `integration "${chosen.name}" changed since it was reviewed; inspect it again and approve the returned ref and digest`,
        409
      );
    }
    return {
      trustClass: "community",
      integrationId: chosen.oimManifest.metadata.id,
      version: chosen.oimManifest.metadata.version,
      packageDigest: chosen.packageDigest,
      hooksAllowed: false,
      approvedCommunityDigest: chosen.packageDigest,
    };
  }
  try {
    return await trust.authorizeInstall({
      package: oimReleasePackage(chosen),
      ...(input.signedRelease === undefined ? {} : { signedRelease: input.signedRelease }),
      ...(input.approvedCommunityDigest === undefined
        ? {}
        : { approvedCommunityDigest: input.approvedCommunityDigest }),
    });
  } catch (error) {
    throw new IntegrationInstallError(errorMessage(error), 409);
  }
}

export async function reviewOimTrust(
  chosen: DiscoveredIntegration,
  signedRelease: unknown,
  trust?: OimInstallTrust
): Promise<{
  readonly support: "official" | "community";
  readonly issues: readonly string[];
  readonly hooksAllowed: boolean;
  readonly autoPatchEligible: boolean;
  readonly signerKeyId?: string;
  readonly revocationSequence?: number;
}> {
  if (chosen.oimManifest === undefined) {
    return {
      support: "community",
      issues: chosen.issues,
      hooksAllowed: false,
      autoPatchEligible: false,
    };
  }
  const authorization = await authorizeOimInstall(
    chosen,
    signedRelease === undefined
      ? { approvedCommunityDigest: chosen.packageDigest }
      : { signedRelease },
    trust
  );
  return {
    support: authorization.trustClass,
    issues: authorizedIssues(chosen, authorization),
    hooksAllowed: authorization.hooksAllowed,
    autoPatchEligible: authorization.trustClass === "official",
    ...(authorization.trustClass === "official"
      ? {
          signerKeyId: authorization.signerKeyId,
          revocationSequence: authorization.revocationSequence,
        }
      : {}),
  };
}

async function recordOimProvenance(
  chosen: DiscoveredIntegration,
  source: string,
  authorization: OimPackageAuthorization,
  options: {
    readonly autoPatchOptIn?: boolean;
  },
  trust: OimInstallTrust,
  existing?: InstalledOimReleaseProvenance | null
): Promise<void> {
  if (chosen.oimManifest === undefined) return;
  await trust.recordInstalledProvenance({
    authorization,
    businessId: DEPLOYMENT_BUSINESS_ID,
    source,
    originalRequirements:
      existing === undefined || existing === null
        ? chosen.oimManifest
        : parseOimManifest(stringifyYaml(existing.originalRequirements)),
    autoPatchOptIn:
      authorization.trustClass === "official"
        ? (options.autoPatchOptIn ?? existing?.autoPatchOptIn ?? true)
        : false,
  });
}

function inverseOimPublication(
  soulWriter: SoulWriter,
  changes: readonly SoulWrite[]
): readonly SoulWrite[] {
  return changes.map((change): SoulWrite => {
    if (change.op !== "put") {
      throw new Error("cannot safely roll back this OIM publication");
    }
    const previous =
      change.target.companion === undefined
        ? soulWriter.read(change.target.kind, change.target.slug)
        : soulWriter.readCompanion(
            change.target.kind,
            change.target.slug ?? "",
            change.target.companion
          );
    return previous === null
      ? { op: "delete", target: change.target }
      : { op: "put", target: change.target, content: previous };
  });
}

async function publishOimWithProvenance(
  request: SoulWriteRequest,
  deps: { readonly soulWriter: SoulWriter; readonly soulLoader: SoulLoader },
  record?: () => Promise<void>
): Promise<void> {
  const rollback =
    record === undefined ? undefined : inverseOimPublication(deps.soulWriter, request.changes);
  const publication = await deps.soulWriter.apply(request);
  if (record !== undefined) {
    try {
      if (publication.published === false) {
        throw new Error(publication.publicationError ?? "Soul publication did not become active");
      }
      await record();
    } catch (error) {
      try {
        await deps.soulWriter.apply({
          ...request,
          subject: `${request.subject} rollback`,
          changes: rollback ?? [],
          expectedBaseCommit: publication.commitSha,
        });
        await deps.soulLoader.reload();
      } catch (rollbackError) {
        throw new Error(
          `OIM provenance persistence failed and Soul rollback failed: ${errorMessage(error)}; ${errorMessage(rollbackError)}`
        );
      }
      throw new Error(
        `OIM provenance persistence failed; Soul publication was reverted: ${errorMessage(error)}`
      );
    }
  }
  await deps.soulLoader.reload();
}

function majorLifecycleInstallError(error: unknown): IntegrationInstallError {
  if (!(error instanceof OimMajorLifecycleError)) throw error;
  const status = ["invalid_slug", "invalid_version"].includes(error.code) ? 400 : 409;
  return new IntegrationInstallError(error.message, status);
}

function resolveInstalledOimArtifact(
  integrations: ReadonlyMap<string, SoulIntegration>,
  slugOrAlias: string
) {
  try {
    const direct = integrations.get(slugOrAlias);
    if (direct?.oimManifest !== undefined) {
      const artifact = resolveOimMajorArtifact(integrations.values(), {
        id: direct.oimManifest.metadata.id,
        majorVersion: oimManifestMajor(direct.oimManifest),
      });
      return artifact === undefined || artifact.slug
        ? artifact
        : { ...artifact, slug: slugOrAlias };
    }
    if (direct !== undefined) return undefined;
    return resolveOimUnversionedAlias(integrations.values(), slugOrAlias);
  } catch (error) {
    throw majorLifecycleInstallError(error);
  }
}

/**
 * The Soul writes that land one discovered package.
 *
 * An OIM manifest is addressed as a companion rather than a definition because the layout registry
 * knows one superseded definition file for an Integration (`manifest.yml`), and a kind with two
 * cannot be addressed by mode without the caller guessing which one the read side resolves.
 * Discovery already refuses a directory declaring both, and the loader quarantines one, so the
 * ambiguity this bypasses is caught on either side of the write.
 */
export function packageChanges(chosen: DiscoveredIntegration): {
  changes: SoulWrite[];
  hash: string;
} {
  if (chosen.oimManifest !== undefined) {
    const manifestYaml = stringifyYaml(chosen.oimManifest);
    const changes: SoulWrite[] = [
      {
        op: "put",
        target: { kind: "Integration", slug: chosen.name, companion: "oim.yml" },
        content: manifestYaml,
      },
    ];
    // Verbatim: every companion is content-addressed in the manifest, so re-serializing one would
    // break the digest the package declares for it.
    for (const [path, content] of chosen.companions ?? []) {
      changes.push({
        op: "put",
        target: { kind: "Integration", slug: chosen.name, companion: path },
        content,
      });
    }
    if (chosen.setupGuide && !chosen.companions?.has("setup-guide.md")) {
      changes.push({
        op: "put",
        target: { kind: "Integration", slug: chosen.name, companion: "setup-guide.md" },
        content: chosen.setupGuide,
      });
    }
    return { changes, hash: createHash("sha256").update(manifestYaml).digest("hex") };
  }

  // Normalize manifest bytes; filtering is enforced by manifestIssues() above.
  const manifestYaml = stringifyYaml(chosen.manifest);
  const changes: SoulWrite[] = [
    {
      op: "put",
      target: { kind: "Integration", slug: chosen.name, definitionMode: "legacy" },
      content: manifestYaml,
    },
  ];
  if (chosen.setupGuide) {
    changes.push({
      op: "put",
      target: { kind: "Integration", slug: chosen.name, companion: "setup-guide.md" },
      content: chosen.setupGuide,
    });
  }
  // Verbatim, unlike the manifest: round-tripping a generated spec only churns it. A declared-but-
  // missing spec is fatal to the loader, so it must land in the same changeset.
  if (chosen.egressSpec) {
    changes.push({
      op: "put",
      target: { kind: "Integration", slug: chosen.name, companion: chosen.egressSpec.file },
      content: chosen.egressSpec.raw,
    });
  }
  return { changes, hash: createHash("sha256").update(manifestYaml).digest("hex") };
}

/**
 * Inspect a guarded Git clone or direct HTTPS manifest without writing anything.
 *
 * The install route repeats this exact path and requires the returned reference and package digest,
 * so changing a source after review cannot inherit that approval.
 */
export async function inspectIntegrationSource(
  source: string,
  actorId: string,
  deps: { readonly http?: EgressHttpPort } = {}
): Promise<SourceInspection> {
  if (isDirectOimSource(source)) {
    try {
      const direct = await fetchDirectOimPackage(source, deps.http ?? directHttp());
      const fixtureResults = await runOimFixtures(direct.manifest, direct.companions);
      const hookIssues =
        (direct.manifest.hooks ?? []).length > 0
          ? ["hooks: an unsigned package may not declare JavaScript hooks"]
          : [];
      const entry: DiscoveredIntegration = {
        name: direct.manifest.metadata.id,
        oimManifest: direct.manifest,
        companions: direct.companions,
        packageDigest: oimPackageDigest(direct.manifest),
        manifestPath: "oim.yml",
        issues: [
          ...(NAME_RE.test(direct.manifest.metadata.id)
            ? []
            : [`integration id is not a safe install name: ${direct.manifest.metadata.id}`]),
          ...executablePayloadIssues((direct.manifest.files ?? []).map((file) => file.path)),
          ...hookIssues,
          ...oimPackageIssues(direct.manifest, direct.companions),
          ...fixtureResults
            .filter((fixture) => !fixture.passed)
            .map((fixture) => `fixture ${fixture.name} failed: ${fixture.error}`),
        ],
        ...(fixtureResults.length === 0 ? {} : { fixtureResults }),
      };
      return {
        source: direct.source,
        sourceType: "https",
        ref: direct.ref,
        integrations: [entry],
      };
    } catch (error) {
      throw new IntegrationInstallError(errorMessage(error), 400);
    }
  }

  try {
    return await withGitSourceClone(
      source,
      { prefix: "integration-scan-", actorId },
      async ({ dir, ref }) => {
        const integrations = await discoverIntegrations(dir);
        if (integrations.length === 0) {
          throw new IntegrationInstallError("no integration manifest found in repo", 400);
        }
        return {
          source: safeGitSource(source),
          sourceType: sourceType(source),
          ref,
          integrations,
        };
      }
    );
  } catch (error) {
    const denial = gitSourceHttpError(error);
    if (!denial) throw error;
    throw new IntegrationInstallError(denial.body.error, denial.status);
  }
}

/** Installs one Integration and refuses overwrites to keep manifest ownership unambiguous. */
export async function installIntegrationFromSource(
  options: {
    source: string;
    /** Which integration to take when the repo offers more than one. */
    name?: string;
    /** Opaque source reference returned by inspection. Required for OIM packages. */
    ref?: string;
    /** Exact OIM package digest approved from the inspection response. */
    approveDigest?: string;
    /** Detached release signature envelope; never included in the package digest. */
    signedRelease?: unknown;
    /** New Official installs enable compatible patches by default; false opts out. */
    autoPatchOptIn?: boolean;
  },
  deps: {
    soulLoader: SoulLoader;
    /** ADR-007 write gateway: the lock read, validation, and the atomic commit all go through it. */
    soulWriter: SoulWriter;
    bundledSlugs: ReadonlySet<string>;
    actor?: CommitActor;
    /** Whoever asked; the clone gate bounds concurrent scans per actor. */
    actorId: string;
    /** Injected for hermetic direct-HTTPS package tests. */
    http?: EgressHttpPort;
    /** Durable release authorization and provenance; parent composition supplies production use. */
    releaseTrust?: OimInstallTrust;
  }
): Promise<InstallResult> {
  const inspection = await inspectIntegrationSource(options.source, deps.actorId, {
    ...(deps.http === undefined ? {} : { http: deps.http }),
  });
  const { ref, integrations } = inspection;

  let chosen: DiscoveredIntegration | undefined;
  if (options.name) {
    chosen = integrations.find((entry) => entry.name === options.name);
    if (!chosen) {
      throw new IntegrationInstallError(
        `integration "${options.name}" not found in ${inspection.source}`,
        404
      );
    }
  } else if (integrations.length === 1) {
    chosen = integrations[0];
  } else {
    throw new IntegrationInstallError(
      `repo offers ${integrations.length} integrations (${integrations
        .map((entry) => entry.name)
        .join(", ")}) — name which one to install`,
      400
    );
  }

  if (chosen.oimManifest !== undefined && options.ref !== ref) {
    throw new IntegrationInstallError(
      `integration "${chosen.name}" changed since it was reviewed; inspect it again and approve the returned ref and digest`,
      409
    );
  }

  let installedName = chosen.name;
  let integrationId: string | undefined;
  let majorVersion: number | undefined;
  if (chosen.oimManifest !== undefined) {
    let target: ReturnType<typeof resolveOimMajorInstallTarget>;
    try {
      target = resolveOimMajorInstallTarget(
        chosen.oimManifest,
        deps.soulLoader.integrations.values(),
        [...deps.bundledSlugs, ...Object.keys(readIntegrationLock(deps.soulWriter).integrations)]
      );
    } catch (error) {
      throw majorLifecycleInstallError(error);
    }
    if (target.disposition === "update") {
      return updateIntegrationFromSource(
        {
          source: options.source,
          name: target.slug,
          ref: options.ref,
          approveDigest: options.approveDigest,
          signedRelease: options.signedRelease,
          autoPatchOptIn: options.autoPatchOptIn,
        },
        deps
      );
    }
    installedName = target.slug;
    integrationId = target.integrationId;
    majorVersion = target.majorVersion;
  }

  const authorization =
    chosen.oimManifest === undefined
      ? undefined
      : await authorizeOimInstall(
          chosen,
          {
            approvedCommunityDigest: options.approveDigest,
            signedRelease: options.signedRelease,
          },
          deps.releaseTrust
        );
  if (authorization !== undefined) {
    requireOfficialAutoPatch(authorization, options.autoPatchOptIn);
  }
  const releaseTrust = deps.releaseTrust;
  const issues =
    authorization === undefined ? chosen.issues : authorizedIssues(chosen, authorization);
  if (issues.length > 0) {
    throw new IntegrationInstallError(
      `integration "${chosen.name}" is not installable: ${issues.join("; ")}`,
      400
    );
  }

  if (deps.bundledSlugs.has(installedName) || deps.soulLoader.integrations.has(installedName)) {
    throw new IntegrationInstallError(`integration already installed: ${installedName}`, 409);
  }

  // Manifest, companions and lock land as one changeset, so a rejected write leaves no
  // half-installed directory for the loader to trust on boot.
  const installedPackage =
    installedName === chosen.name ? chosen : { ...chosen, name: installedName };
  const { changes, hash } = packageChanges(installedPackage);

  const lock = readIntegrationLock(deps.soulWriter);
  lock.integrations[installedName] = {
    // The lock is committed and pushed, so source credentials and query tokens never become
    // provenance. File and shorthand sources survive unchanged.
    sourceUrl: inspection.source,
    sourceType: inspection.sourceType,
    manifestPath: chosen.manifestPath,
    ref,
    hash,
    ...(chosen.oimManifest === undefined
      ? {}
      : {
          definition: "oim" as const,
          packageDigest: chosen.packageDigest,
          integrationId,
          majorVersion,
        }),
  };
  changes.push({
    op: "put",
    target: { kind: "IntegrationsLock" },
    content: serializeIntegrationLock(lock),
  });

  await publishOimWithProvenance(
    {
      subject: `soul: install integration ${installedName}`,
      source: "api",
      actor: deps.actor ?? SYSTEM_SOUL_COMMIT_ACTOR,
      businessId: DEPLOYMENT_BUSINESS_ID,
      changes,
    },
    deps,
    authorization === undefined || releaseTrust === undefined
      ? undefined
      : () =>
          recordOimProvenance(
            installedPackage,
            inspection.source,
            authorization,
            { autoPatchOptIn: options.autoPatchOptIn },
            releaseTrust
          )
  );

  return {
    name: installedName,
    source: inspection.source,
    ref,
    ...(integrationId === undefined ? {} : { integrationId }),
    ...(majorVersion === undefined ? {} : { majorVersion }),
    ...(authorization === undefined ? {} : { support: authorization.trustClass }),
    ...(chosen.packageDigest === undefined ? {} : { packageDigest: chosen.packageDigest }),
  };
}

/** Updates an already installed Integration from its source repository. */
export async function updateIntegrationFromSource(
  options: {
    source?: string;
    name: string;
    /** The new package digest an administrator has reviewed, for an OIM package that changed. */
    approveDigest?: string;
    /** Opaque source reference returned with the reviewed package. */
    ref?: string;
    /** Detached release signature envelope for an Official package. */
    signedRelease?: unknown;
    /** Omission preserves the installed preference; false opts out of compatible patches. */
    autoPatchOptIn?: boolean;
  },
  deps: {
    soulLoader: SoulLoader;
    soulWriter: SoulWriter;
    bundledSlugs: ReadonlySet<string>;
    actor?: CommitActor;
    actorId: string;
    http?: EgressHttpPort;
    releaseTrust?: OimInstallTrust;
  }
): Promise<InstallResult> {
  const lock = readIntegrationLock(deps.soulWriter);
  const artifact = resolveInstalledOimArtifact(deps.soulLoader.integrations, options.name);
  const installedName = artifact?.slug ?? options.name;
  const source = options.source ?? lock.integrations[installedName]?.sourceUrl;
  if (!source) {
    throw new IntegrationInstallError(
      `no source repository known for integration "${options.name}"`,
      400
    );
  }

  const inspection = await inspectIntegrationSource(source, deps.actorId, {
    ...(deps.http === undefined ? {} : { http: deps.http }),
  });
  const { ref, integrations } = inspection;
  const installed = deps.soulLoader.integrations.get(installedName);
  const lockEntry = lock.integrations[installedName];
  const sourceIntegrationId =
    lockEntry?.integrationId ?? installed?.oimManifest?.metadata.id ?? installedName;
  const sourceMajorVersion =
    lockEntry?.majorVersion ??
    artifact?.majorVersion ??
    (installed?.oimManifest === undefined ? undefined : oimManifestMajor(installed.oimManifest));
  const discovered =
    integrations.find(
      (entry) =>
        entry.oimManifest !== undefined &&
        entry.oimManifest.metadata.id === sourceIntegrationId &&
        sourceMajorVersion !== undefined &&
        oimManifestMajor(entry.oimManifest) === sourceMajorVersion
    ) ??
    integrations.find((entry) =>
      entry.oimManifest === undefined
        ? entry.name === sourceIntegrationId
        : entry.oimManifest.metadata.id === sourceIntegrationId
    );
  const chosen =
    discovered === undefined || discovered.name === installedName
      ? discovered
      : { ...discovered, name: installedName };
  if (!chosen) {
    throw new IntegrationInstallError(
      `integration "${options.name}" not found in ${inspection.source}`,
      404
    );
  }

  if (deps.bundledSlugs.has(chosen.name)) {
    throw new IntegrationInstallError(`cannot update bundled integration: ${chosen.name}`, 409);
  }

  const existingDefinition =
    lockEntry?.definition === "oim" || installed?.oimManifest !== undefined ? "oim" : "legacy";
  const candidateDefinition = chosen.oimManifest === undefined ? "legacy" : "oim";
  if (existingDefinition !== candidateDefinition) {
    throw new IntegrationInstallError(
      `cannot change integration "${chosen.name}" from ${existingDefinition === "oim" ? "OIM oim.yml" : "legacy manifest.yml"} to ${candidateDefinition === "oim" ? "OIM oim.yml" : "legacy manifest.yml"} with an update; uninstall it before installing the new format`,
      409
    );
  }

  if (installed?.oimManifest !== undefined && chosen.oimManifest !== undefined) {
    const existingMajor = Number(installed.oimManifest.metadata.version.split(".", 1)[0]);
    const candidateMajor = Number(chosen.oimManifest.metadata.version.split(".", 1)[0]);
    if (existingMajor !== candidateMajor) {
      throw new IntegrationInstallError(
        `cannot update OIM integration "${chosen.name}" across major version ${existingMajor} to ${candidateMajor}; use the install endpoint to add the new major beside it`,
        409
      );
    }
    const compatibilityIssues = oimCompatibilityIssues(installed.oimManifest, chosen.oimManifest);
    if (compatibilityIssues.length > 0) {
      throw new IntegrationInstallError(
        `incompatible OIM update for "${chosen.name}": ${compatibilityIssues.join("; ")}`,
        409
      );
    }
  }

  // An OIM package's digest is what an administrator approved, so an update that changes it is a
  // new grant of authority and must be approved as one. Naming the digest is the approval: a
  // caller who has not read the review cannot produce it.
  const approved = lock.integrations[installedName]?.packageDigest;
  if (
    chosen.oimManifest !== undefined &&
    approved !== chosen.packageDigest &&
    options.ref !== ref
  ) {
    throw new IntegrationInstallError(
      `integration "${chosen.name}" changed since it was approved (${chosen.packageDigest}); review it and re-run the update with that ref and digest`,
      409
    );
  }
  const existingProvenance =
    chosen.oimManifest === undefined || deps.releaseTrust === undefined
      ? undefined
      : await deps.releaseTrust.installedProvenance(
          DEPLOYMENT_BUSINESS_ID,
          chosen.oimManifest.metadata.id,
          oimManifestMajor(chosen.oimManifest)
        );
  const signedRelease = options.signedRelease ?? existingProvenance?.signedRelease;
  const authorization =
    chosen.oimManifest === undefined
      ? undefined
      : await authorizeOimInstall(
          chosen,
          {
            signedRelease,
            approvedCommunityDigest:
              options.approveDigest ??
              (approved === chosen.packageDigest ? chosen.packageDigest : undefined),
          },
          deps.releaseTrust
        );
  if (authorization !== undefined) {
    requireOfficialAutoPatch(authorization, options.autoPatchOptIn);
  }
  const releaseTrust = deps.releaseTrust;
  const issues =
    authorization === undefined ? chosen.issues : authorizedIssues(chosen, authorization);
  if (issues.length > 0) {
    throw new IntegrationInstallError(
      `integration "${chosen.name}" is not installable: ${issues.join("; ")}`,
      400
    );
  }

  const { changes, hash } = packageChanges(chosen);

  lock.integrations[chosen.name] = {
    sourceUrl: inspection.source,
    sourceType: inspection.sourceType,
    manifestPath: chosen.manifestPath,
    ref,
    hash,
    ...(chosen.oimManifest === undefined
      ? {}
      : {
          definition: "oim" as const,
          packageDigest: chosen.packageDigest,
          integrationId: chosen.oimManifest.metadata.id,
          majorVersion: oimManifestMajor(chosen.oimManifest),
        }),
  };
  changes.push({
    op: "put",
    target: { kind: "IntegrationsLock" },
    content: serializeIntegrationLock(lock),
  });

  await publishOimWithProvenance(
    {
      subject: `soul: update integration ${chosen.name}`,
      source: "api",
      actor: deps.actor ?? SYSTEM_SOUL_COMMIT_ACTOR,
      businessId: DEPLOYMENT_BUSINESS_ID,
      changes,
    },
    deps,
    authorization === undefined || releaseTrust === undefined
      ? undefined
      : () =>
          recordOimProvenance(
            chosen,
            inspection.source,
            authorization,
            {
              autoPatchOptIn: options.autoPatchOptIn ?? existingProvenance?.autoPatchOptIn,
            },
            releaseTrust,
            existingProvenance
          )
  );

  return {
    name: chosen.name,
    source: inspection.source,
    ref,
    ...(chosen.oimManifest === undefined
      ? {}
      : {
          integrationId: chosen.oimManifest.metadata.id,
          majorVersion: oimManifestMajor(chosen.oimManifest),
        }),
    ...(authorization === undefined ? {} : { support: authorization.trustClass }),
    ...(chosen.packageDigest === undefined ? {} : { packageDigest: chosen.packageDigest }),
  };
}

/** Removes exactly one installed storage artifact and its matching provenance lock entry. */
export async function removeIntegrationFromSoul(
  options: { name: string },
  deps: {
    soulLoader: SoulLoader;
    soulWriter: SoulWriter;
    bundledSlugs: ReadonlySet<string>;
    actor?: CommitActor;
  }
): Promise<RemoveResult> {
  if (!NAME_RE.test(options.name)) {
    throw new IntegrationInstallError(`integration not found: ${options.name}`, 404);
  }
  const artifact = resolveInstalledOimArtifact(deps.soulLoader.integrations, options.name);
  const name = artifact?.slug ?? options.name;
  const installed = deps.soulLoader.integrations.get(name);
  if (installed === undefined) {
    throw new IntegrationInstallError(`integration not found: ${options.name}`, 404);
  }
  if (deps.bundledSlugs.has(name)) {
    throw new IntegrationInstallError(`cannot remove bundled integration: ${name}`, 409);
  }

  const lock = readIntegrationLock(deps.soulWriter);
  const changes: SoulWrite[] = [{ op: "deleteArtifact", kind: "Integration", slug: name }];
  if (name in lock.integrations) {
    delete lock.integrations[name];
    changes.push({
      op: "put",
      target: { kind: "IntegrationsLock" },
      content: serializeIntegrationLock(lock),
    });
  }
  await deps.soulWriter.apply({
    subject: `soul: remove integration ${name}`,
    source: "api",
    actor: deps.actor ?? SYSTEM_SOUL_COMMIT_ACTOR,
    businessId: DEPLOYMENT_BUSINESS_ID,
    changes,
  });
  await deps.soulLoader.reload();

  return {
    name,
    ...(artifact === undefined
      ? {}
      : { integrationId: artifact.integrationId, majorVersion: artifact.majorVersion }),
  };
}
