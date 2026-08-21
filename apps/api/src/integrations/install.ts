import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { gitSourceHttpError, withGitSourceClone } from "@tulipfarm/integrations";
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
  manifest: IntegrationManifest;
  setupGuide?: string;
  /** OpenAPI spec carried verbatim beside its Integration manifest. */
  egressSpec?: { file: string; raw: string };
  /** Path of the manifest.yml relative to the repo root, recorded for provenance. */
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
      if (!entry.isFile() || entry.name !== "manifest.yml") continue;

      const name = dir === root ? "" : (dir.split(/[\\/]/).pop() ?? "");
      if (!NAME_RE.test(name)) continue;

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

  // Normalize manifest bytes; filtering is enforced by manifestIssues() above.
  const manifestYaml = stringifyYaml(chosen.manifest);

  // `definitionMode: "legacy"` keeps the on-disk `manifest.yml` the loader reads, rather than the
  // gateway's canonical `integration.yaml`. Manifest, companions and lock land as one changeset, so
  // a rejected write leaves no half-installed directory for the loader to trust on boot.
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

  const lock = readIntegrationLock(deps.soulWriter);
  lock.integrations[chosen.name] = {
    // The lock is committed and pushed, so a credentialed https source would leak its token to the
    // remote. Strip only the credential; file/shorthand sources must survive as provenance.
    sourceUrl: stripUrlCredentials(options.source),
    sourceType: sourceType(options.source),
    manifestPath: chosen.manifestPath,
    ref,
    hash: createHash("sha256").update(manifestYaml).digest("hex"),
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

  return { name: chosen.name, source: stripUrlCredentials(options.source), ref };
}

/** Updates an already installed Integration from its source repository. */
export async function updateIntegrationFromSource(
  options: {
    source?: string;
    name: string;
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
  if (chosen.egressSpec) {
    changes.push({
      op: "put",
      target: { kind: "Integration", slug: chosen.name, companion: chosen.egressSpec.file },
      content: chosen.egressSpec.raw,
    });
  }

  lock.integrations[chosen.name] = {
    sourceUrl: stripUrlCredentials(source),
    sourceType: sourceType(source),
    manifestPath: chosen.manifestPath,
    ref,
    hash: createHash("sha256").update(manifestYaml).digest("hex"),
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

  return { name: chosen.name, source: stripUrlCredentials(source), ref };
}
