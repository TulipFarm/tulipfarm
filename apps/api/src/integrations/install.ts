import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import {
  type GitSyncService,
  type IntegrationManifest,
  type SoulLoader,
  validateAuthSteps,
  validateThirdPartyManifest,
} from "@tulipfarm/soul";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { cloneToTemp, sourceType } from "../soul/git-source";

/*
 * Install an integration from a git repo.
 *
 * The whole framework rests on this staying boring: a repo contributes `manifest.yml` (data) and
 * an optional `setup-guide.md` (prose). Nothing else is copied, so "installing an integration"
 * cannot mean "running someone's code". Everything a provider needs — its create-app URL, OAuth
 * endpoints, response mappings, webhook shape — is already expressible in the manifest, which is
 * why the bundled Slack and GitHub integrations carry no bespoke connect code either.
 *
 * There is deliberately no scan/preview cache (Skills need one because an LLM audit runs between
 * scan and install). Validation here is mechanical, so preview and install can each just clone.
 */

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_FILE_BYTES = 512 * 1024;
/**
 * Specs get their own, larger cap: a provider's OpenAPI document is generated, not hand-written,
 * and legitimately dwarfs a manifest. Still bounded — it is parsed and compiled to JSON Schema on
 * every boot, so an unbounded one is a startup cost an operator never agreed to.
 */
const MAX_SPEC_BYTES = 2 * 1024 * 1024;

export interface DiscoveredIntegration {
  /** Directory name in the source repo, which becomes the install slug. */
  name: string;
  manifest: IntegrationManifest;
  setupGuide?: string;
  /**
   * The OpenAPI document an `egress: { type: "openapi" }` manifest names, carried verbatim so it
   * can be written alongside the manifest. Without it the installed integration declares Tools
   * whose spec is missing, which the loader treats as fatal.
   */
  egressSpec?: { file: string; raw: string };
  /** Path of the manifest.yml relative to the repo root, recorded for provenance. */
  manifestPath: string;
  /** Reasons this integration cannot be installed from an untrusted source; empty means safe. */
  issues: string[];
}

export class IntegrationInstallError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409
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
  // The same connect-flow validation the loader runs, applied before the files land rather than
  // on the next boot: an integration that cannot complete its flow is rejected at install.
  issues.push(...validateAuthSteps(manifest));
  issues.push(...validateThirdPartyManifest(manifest));
  return issues;
}

/**
 * Reads the OpenAPI document an `openapi` manifest names, and reports why it could not be read.
 *
 * A missing or unparseable spec is an install-blocking issue rather than a silent skip: the
 * manifest promises Tools, and letting it install anyway produces an integration an operator can
 * connect but never use. Resolved from the directory listing exactly like `setup-guide.md`, so a
 * `spec: ../../../etc/passwd` cannot be read into the operator's git repo.
 */
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
 * Walk a cloned repo for `manifest.yml` files and parse each into a DiscoveredIntegration. A
 * manifest whose directory name is not a safe slug is skipped — that name becomes a directory in
 * the soul repo, so it must not allow traversal.
 */
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
      // Regular files only. Dirent uses lstat, so a symlink is neither isFile() nor
      // isDirectory() — which is what keeps a link pointing outside the clone from being read or
      // descended into.
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

      // Same rule as the manifest, and for a sharper reason: the guide is committed and pushed to
      // the operator's own soul remote, so `setup-guide.md -> /proc/self/environ` would publish
      // host secrets to their git host. Resolved from the directory listing, never by path, so the
      // check cannot be separated from the read.
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

export async function readIntegrationLock(
  soulPath: string
): Promise<{ version: number; integrations: Record<string, IntegrationLockEntry> }> {
  try {
    const parsed = JSON.parse(await readFile(join(soulPath, "integrations-lock.json"), "utf8")) as {
      version?: number;
      integrations?: Record<string, IntegrationLockEntry>;
    };
    return { version: parsed.version ?? 1, integrations: parsed.integrations ?? {} };
  } catch {
    return { version: 1, integrations: {} };
  }
}

export async function writeIntegrationLock(
  soulPath: string,
  lock: { version: number; integrations: Record<string, IntegrationLockEntry> }
): Promise<void> {
  await writeFile(
    join(soulPath, "integrations-lock.json"),
    `${JSON.stringify(lock, null, 2)}\n`,
    "utf8"
  );
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
export async function inspectIntegrationSource(source: string): Promise<{
  ref: string;
  integrations: DiscoveredIntegration[];
}> {
  let dir: string | undefined;
  try {
    const clone = await cloneToTemp(source, "integration-scan-");
    dir = clone.dir;
    const integrations = await discoverIntegrations(dir);
    if (integrations.length === 0) {
      throw new IntegrationInstallError("no manifest.yml found in repo", 400);
    }
    return { ref: clone.ref, integrations };
  } catch (error) {
    if (error instanceof IntegrationInstallError) throw error;
    throw new IntegrationInstallError(
      `clone failed: ${error instanceof Error ? error.message : String(error)}`,
      400
    );
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Install one integration from a git repo into the soul repo.
 *
 * Refuses to overwrite an existing slug. That is not just tidiness: `mergeIntegrations` prefers a
 * bundled manifest over the soul copy, so a third-party install under a bundled slug would be
 * silently ignored — and an install that appears to succeed while doing nothing is worse than a
 * clear rejection.
 */
export async function installIntegrationFromSource(
  options: {
    source: string;
    /** Which integration to take when the repo offers more than one. */
    name?: string;
  },
  deps: {
    soulLoader: SoulLoader;
    gitSync: GitSyncService;
    bundledSlugs: ReadonlySet<string>;
  }
): Promise<InstallResult> {
  const { ref, integrations } = await inspectIntegrationSource(options.source);

  let chosen: DiscoveredIntegration | undefined;
  if (options.name) {
    chosen = integrations.find((entry) => entry.name === options.name);
    if (!chosen) {
      throw new IntegrationInstallError(
        `integration "${options.name}" not found in ${options.source}`,
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

  // Re-serialized from the parsed object rather than copied verbatim, so YAML comments, anchors,
  // and any trailing document don't ride along into the operator's repo, and the bytes on disk are
  // normalized. Note this does NOT strip unknown keys — it is a hygiene step, not a filter; the
  // security boundary is manifestIssues() above.
  const manifestYaml = stringifyYaml(chosen.manifest);
  const dir = join(deps.gitSync.path, "integrations", chosen.name);

  // Anything left behind by a failed install is loaded and trusted on the next boot — the loader
  // reads the integrations directory and never consults the lock. So the directory is removed if
  // any step after the first write fails, rather than leaving a half-installed integration.
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "manifest.yml"), manifestYaml, "utf8");
    if (chosen.setupGuide) {
      await writeFile(join(dir, "setup-guide.md"), chosen.setupGuide, "utf8");
    }
    // Verbatim, unlike the manifest: the spec is a generated provider document that round-tripping
    // would only churn, and it is read as data, never executed.
    if (chosen.egressSpec) {
      await writeFile(join(dir, chosen.egressSpec.file), chosen.egressSpec.raw, "utf8");
    }

    const lock = await readIntegrationLock(deps.gitSync.path);
    lock.integrations[chosen.name] = {
      sourceUrl: options.source,
      sourceType: sourceType(options.source),
      manifestPath: chosen.manifestPath,
      ref,
      hash: createHash("sha256").update(manifestYaml).digest("hex"),
    };
    await writeIntegrationLock(deps.gitSync.path, lock);

    await deps.gitSync.withSync(`soul: install integration ${chosen.name}`);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    await deps.soulLoader.reload();
    throw error;
  }
  await deps.soulLoader.reload();

  return { name: chosen.name, source: options.source, ref };
}
