import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import {
  gitSourceHttpError,
  type OimFixtureResult,
  runOimFixtures,
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
  type SoulLoader,
  type SoulWrite,
  type SoulWriter,
  sourceType,
  validateAuthSteps,
  validateThirdPartyManifest,
} from "@tulipfarm/soul";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { stripUrlCredentials } from "../audit/soul-write";
import { SYSTEM_SOUL_COMMIT_ACTOR } from "../runtime/soul-writer";

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

function executablePayloadIssues(entries: readonly Dirent[]): string[] {
  const issues: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const lower = entry.name.toLowerCase();
    if (
      EXECUTABLE_FILENAMES.has(entry.name) ||
      EXECUTABLE_EXTENSIONS.some((extension) => lower.endsWith(extension))
    ) {
      issues.push(`package carries an executable payload: ${entry.name}`);
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
  entries: readonly Dirent[],
  manifest: OimManifest
): Promise<{ companions: Map<string, string>; issues: string[] }> {
  const companions = new Map<string, string>();
  const issues: string[] = [];
  for (const file of manifest.files ?? []) {
    const name = basename(file.path);
    if (name !== file.path) {
      issues.push(`files: ${file.path} must sit beside oim.yml`);
      continue;
    }
    if (!entries.some((sibling) => sibling.name === name && sibling.isFile())) {
      issues.push(`files: ${file.path} is declared but missing`);
      continue;
    }
    const raw = await readFile(join(dir, name), "utf8");
    if (Buffer.byteLength(raw) > MAX_SPEC_BYTES) {
      issues.push(`files: ${file.path} exceeds ${MAX_SPEC_BYTES} bytes`);
      continue;
    }
    companions.set(file.path, raw);
  }
  return { companions, issues };
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

  const base: Omit<DiscoveredIntegration, "issues"> = {
    name,
    manifestPath: relative(root, full),
  };
  if (entries.some((sibling) => sibling.name === "manifest.yml" && sibling.isFile())) {
    return { ...base, issues: ["declares both oim.yml and manifest.yml; keep exactly one"] };
  }

  let oimManifest: OimManifest;
  try {
    oimManifest = parseOimManifest(raw);
  } catch (error) {
    return { ...base, issues: [`oim.yml is not a valid manifest: ${errorMessage(error)}`] };
  }

  const { companions, issues: companionIssues } = await readOimCompanions(
    dir,
    entries,
    oimManifest
  );
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
      ...executablePayloadIssues(entries),
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
      if (!NAME_RE.test(name)) continue;

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

      // Never follow setup-guide symlinks; the guide is committed to the operator's Soul repo.
      let setupGuide: string | undefined;
      if (entries.some((sibling) => sibling.name === "setup-guide.md" && sibling.isFile())) {
        const guide = await readFile(join(dir, "setup-guide.md"), "utf8");
        if (Buffer.byteLength(guide) <= MAX_FILE_BYTES) setupGuide = guide;
      }

      const spec = await readEgressSpec(dir, entries, manifest);

      found.push({
        name,
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
  /** Present for an OIM package: the exact bytes now installed. */
  packageDigest?: string;
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
    if (chosen.setupGuide) {
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
 * Clone `source` and report what it offers, without writing anything. The install route uses the
 * same discovery, so a preview can never disagree with what installing would do.
 */
export async function inspectIntegrationSource(
  source: string,
  actorId: string
): Promise<{
  ref: string;
  integrations: DiscoveredIntegration[];
}> {
  try {
    return await withGitSourceClone(
      source,
      { prefix: "integration-scan-", actorId },
      async ({ dir, ref }) => {
        const integrations = await discoverIntegrations(dir);
        if (integrations.length === 0) {
          throw new IntegrationInstallError("no manifest.yml found in repo", 400);
        }
        return { ref, integrations };
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
  },
  deps: {
    soulLoader: SoulLoader;
    /** ADR-007 write gateway: the lock read, validation, and the atomic commit all go through it. */
    soulWriter: SoulWriter;
    bundledSlugs: ReadonlySet<string>;
    actor?: CommitActor;
    /** Whoever asked; the clone gate bounds concurrent scans per actor. */
    actorId: string;
  }
): Promise<InstallResult> {
  const { ref, integrations } = await inspectIntegrationSource(options.source, deps.actorId);

  let chosen: DiscoveredIntegration | undefined;
  if (options.name) {
    chosen = integrations.find((entry) => entry.name === options.name);
    if (!chosen) {
      throw new IntegrationInstallError(
        `integration "${options.name}" not found in ${stripUrlCredentials(options.source)}`,
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

  if (chosen.issues.length > 0) {
    throw new IntegrationInstallError(
      `integration "${chosen.name}" is not installable: ${chosen.issues.join("; ")}`,
      400
    );
  }

  if (deps.bundledSlugs.has(chosen.name) || deps.soulLoader.integrations.has(chosen.name)) {
    throw new IntegrationInstallError(`integration already installed: ${chosen.name}`, 409);
  }

  // Manifest, companions and lock land as one changeset, so a rejected write leaves no
  // half-installed directory for the loader to trust on boot.
  const { changes, hash } = packageChanges(chosen);

  const lock = readIntegrationLock(deps.soulWriter);
  lock.integrations[chosen.name] = {
    // The lock is committed and pushed, so a credentialed https source would leak its token to the
    // remote. Strip only the credential; file/shorthand sources must survive as provenance.
    sourceUrl: stripUrlCredentials(options.source),
    sourceType: sourceType(options.source),
    manifestPath: chosen.manifestPath,
    ref,
    hash,
    ...(chosen.oimManifest === undefined
      ? {}
      : { definition: "oim" as const, packageDigest: chosen.packageDigest }),
  };
  changes.push({
    op: "put",
    target: { kind: "IntegrationsLock" },
    content: serializeIntegrationLock(lock),
  });

  await deps.soulWriter.apply({
    subject: `soul: install integration ${chosen.name}`,
    source: "api",
    actor: deps.actor ?? SYSTEM_SOUL_COMMIT_ACTOR,
    businessId: DEPLOYMENT_BUSINESS_ID,
    changes,
  });
  await deps.soulLoader.reload();

  return {
    name: chosen.name,
    source: stripUrlCredentials(options.source),
    ref,
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
  },
  deps: {
    soulLoader: SoulLoader;
    soulWriter: SoulWriter;
    bundledSlugs: ReadonlySet<string>;
    actor?: CommitActor;
    actorId: string;
  }
): Promise<InstallResult> {
  const lock = readIntegrationLock(deps.soulWriter);
  const source = options.source ?? lock.integrations[options.name]?.sourceUrl;
  if (!source) {
    throw new IntegrationInstallError(
      `no source repository known for integration "${options.name}"`,
      400
    );
  }

  const { ref, integrations } = await inspectIntegrationSource(source, deps.actorId);
  const chosen = integrations.find((entry) => entry.name === options.name);
  if (!chosen) {
    throw new IntegrationInstallError(
      `integration "${options.name}" not found in ${stripUrlCredentials(source)}`,
      404
    );
  }

  if (chosen.issues.length > 0) {
    throw new IntegrationInstallError(
      `integration "${chosen.name}" is not installable: ${chosen.issues.join("; ")}`,
      400
    );
  }

  if (deps.bundledSlugs.has(chosen.name)) {
    throw new IntegrationInstallError(`cannot update bundled integration: ${chosen.name}`, 409);
  }

  const installed = deps.soulLoader.integrations.get(chosen.name);
  const existingDefinition =
    lock.integrations[chosen.name]?.definition === "oim" || installed?.oimManifest !== undefined
      ? "oim"
      : "legacy";
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
        `cannot update OIM integration "${chosen.name}" across major version ${existingMajor} to ${candidateMajor}; uninstall it before installing the new major`,
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
  const approved = lock.integrations[options.name]?.packageDigest;
  if (
    chosen.oimManifest !== undefined &&
    approved !== undefined &&
    chosen.packageDigest !== approved &&
    options.approveDigest !== chosen.packageDigest
  ) {
    throw new IntegrationInstallError(
      `integration "${chosen.name}" changed since it was approved (${chosen.packageDigest}); review it and re-run the update with that digest`,
      409
    );
  }

  const { changes, hash } = packageChanges(chosen);

  lock.integrations[chosen.name] = {
    sourceUrl: stripUrlCredentials(source),
    sourceType: sourceType(source),
    manifestPath: chosen.manifestPath,
    ref,
    hash,
    ...(chosen.oimManifest === undefined
      ? {}
      : { definition: "oim" as const, packageDigest: chosen.packageDigest }),
  };
  changes.push({
    op: "put",
    target: { kind: "IntegrationsLock" },
    content: serializeIntegrationLock(lock),
  });

  await deps.soulWriter.apply({
    subject: `soul: update integration ${chosen.name}`,
    source: "api",
    actor: deps.actor ?? SYSTEM_SOUL_COMMIT_ACTOR,
    businessId: DEPLOYMENT_BUSINESS_ID,
    changes,
  });
  await deps.soulLoader.reload();

  return {
    name: chosen.name,
    source: stripUrlCredentials(source),
    ref,
    ...(chosen.packageDigest === undefined ? {} : { packageDigest: chosen.packageDigest }),
  };
}
