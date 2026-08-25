import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { join } from "node:path";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { unstorableArtifactPaths, validateSkill } from "@tulipfarm/schema";
import type { CommitActor } from "../commit-signing";
import { sourceType } from "../git-source";
import type { GitSyncService } from "../git-sync";
import { parseFrontmatter, type SoulLoader } from "../published-loader";
import { artifactWriteTarget, type SoulWrite, type SoulWriter } from "../writer";
import type { BundledSkill } from "./bundled";
import { type SkillScanFile, type SkillTrustLevel, scanSkill, skillTrustLevel } from "./guard";
import {
  installedSourceType,
  marketplaceSource,
  readSkillsLock,
  type SkillsLock,
  serializeSkillsLock,
  skillVersionFromFiles,
} from "./lock";
import { mutateSkillsLock } from "./lock-write";
import { collectSkillFiles, discoverSkills, skillDirectoryHash } from "./marketplace-files";
import { mergedSkills } from "./registry";
import { resolveSkillSource } from "./source-url";

type ScanEntry = {
  source: string;
  ref: string;
  skills: DiscoveredSkill[];
  audited: Set<string>;
  expires: number;
};
type MarketplaceManifestEntry = {
  skillId?: string;
  name?: string;
  description?: string;
  category?: string;
  installs?: number;
};

export interface DiscoveredSkill {
  name: string;
  description?: string;
  category?: string;
  skillPath: string;
  content: string;
  files: SkillScanFile[];
}

export type MarketplaceAuditScan = ReturnType<typeof scanSkill> & { trustLevel: SkillTrustLevel };

export interface SkillMarketplaceBrowse {
  scanId: string;
  source: string;
  skills: {
    name: string;
    skillPath: string;
    skillId?: string;
    description?: string;
    category?: string;
    installs?: number;
    installed: boolean;
    updateAvailable: boolean;
  }[];
}

export interface SkillMarketplaceScan {
  scanId: string;
  source: string;
  ref: string;
  skills: {
    name: string;
    skillPath: string;
    description?: string;
    installed: boolean;
    updateAvailable: boolean;
  }[];
}

export interface SkillMarketplaceInstall {
  installed: { name: string; skillPath: string }[];
  source: string;
  ref: string;
}

export class SkillMarketplaceError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422,
    message: string
  ) {
    super(message);
  }
}

export interface SkillMarketplaceSourceInstall extends SkillMarketplaceInstall {
  /** The audit that cleared this package; the install refuses to run without one. */
  report: unknown;
}

export interface SkillMarketplaceFlow {
  browse(): Promise<SkillMarketplaceBrowse>;
  scan(input: { source: string; actorId: string }): Promise<SkillMarketplaceScan>;
  audit(input: { scanId: string; name: string; skillPath?: string }): Promise<{ report: unknown }>;
  install(input: {
    scanId: string;
    names?: string[];
    paths?: string[];
    actor: CommitActor;
    source?: "agent" | "api";
  }): Promise<SkillMarketplaceInstall>;
  installFromSource(input: {
    source: string;
    name?: string;
    actor: CommitActor;
    actorId: string;
    writeSource?: "agent" | "api";
  }): Promise<SkillMarketplaceSourceInstall>;
}

export interface SkillMarketplaceDeps {
  gitSync: GitSyncService;
  soulLoader: SoulLoader;
  soulWriter: SoulWriter;
  bundledSkills?: ReadonlyMap<string, BundledSkill>;
  disabledBundledSkills?: ReadonlySet<string>;
  cloneSource<T>(
    source: string,
    options: { prefix: string; actorId: string },
    action: (clone: { dir: string; ref: string }) => Promise<T>
  ): Promise<T>;
  audit(skill: DiscoveredSkill, deterministicScan: MarketplaceAuditScan): Promise<unknown>;
  executablePackageBlocker(skill: DiscoveredSkill): string | undefined;
}

const SCAN_TTL_MS = 10 * 60 * 1000;
const MAX_SCANS = 25;
const STRUCTURAL_INSTALL_BLOCKERS = new Set([
  "binary_file",
  "oversized_file",
  "oversized_skill",
  "symlink_escape",
  "too_many_files",
]);

function stripUrlCredentials(source: string): string {
  try {
    const url = new URL(source);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return source.replace(/\/\/[^/@]+@/, "//");
  }
}

export function createSkillMarketplaceFlow(deps: SkillMarketplaceDeps): SkillMarketplaceFlow {
  const scans = new Map<string, ScanEntry>();
  const marketplaceCache = new Map<
    string,
    { scanId: string; expires: number; manifest: Map<string, MarketplaceManifestEntry> }
  >();
  const bundledSkills = deps.bundledSkills ?? new Map();
  const disabledBundledSkills = deps.disabledBundledSkills ?? new Set();

  function pruneScans(now: number): void {
    for (const [id, entry] of scans) if (entry.expires <= now) scans.delete(id);
    while (scans.size > MAX_SCANS) {
      const oldest = scans.keys().next().value;
      if (oldest === undefined) break;
      scans.delete(oldest);
    }
  }

  async function browse(): Promise<SkillMarketplaceBrowse> {
    const source = marketplaceSource();
    const now = Date.now();
    const cached = marketplaceCache.get(source);
    const cachedScan = cached ? scans.get(cached.scanId) : undefined;
    if (cached && cached.expires > now && cachedScan) {
      const lock = await readSkillsLock(deps.gitSync.path);
      return {
        scanId: cached.scanId,
        source,
        skills: cachedScan.skills.map((skill) => {
          const meta = cached.manifest.get(skill.name);
          const status = installStatus(
            skill,
            lock,
            deps.soulLoader,
            bundledSkills,
            disabledBundledSkills
          );
          return {
            name: skill.name,
            skillPath: skill.skillPath,
            skillId: asString(meta?.skillId),
            description: skill.description ?? asString(meta?.description),
            category: skill.category ?? asString(meta?.category),
            installs: typeof meta?.installs === "number" ? meta.installs : undefined,
            installed: status.installed,
            updateAvailable:
              status.updateAvailable && lock.skills[skill.name]?.sourceUrl === source,
          };
        }),
      };
    }
    await deps.cloneSource(
      source,
      { prefix: "skill-scan-", actorId: "system:marketplace" },
      async ({ dir, ref }) => {
        const scanId = randomUUID();
        pruneScans(now);
        scans.set(scanId, {
          source,
          ref,
          skills: await discoverSkills(dir),
          audited: new Set(),
          expires: now + SCAN_TTL_MS,
        });
        marketplaceCache.set(source, {
          scanId,
          expires: now + SCAN_TTL_MS,
          manifest: await readManifest(dir),
        });
      }
    );
    return browse();
  }

  async function scan(input: { source: string; actorId: string }): Promise<SkillMarketplaceScan> {
    // Resolving here rather than only in `installFromSource` means a catalogue URL pasted into the
    // scan box behaves the same as one handed to an Agent, and provenance records the real remote.
    const source = resolveSkillSource(input.source).source;
    return deps.cloneSource(
      source,
      { prefix: "skill-scan-", actorId: input.actorId },
      async ({ dir, ref }) => {
        const discovered = await discoverSkills(dir);
        if (discovered.length === 0) {
          throw new SkillMarketplaceError(400, "no SKILL.md files found in repo");
        }
        const lock = await readSkillsLock(deps.gitSync.path);
        const scanId = randomUUID();
        pruneScans(Date.now());
        scans.set(scanId, {
          source,
          ref,
          skills: discovered,
          audited: new Set(),
          expires: Date.now() + SCAN_TTL_MS,
        });
        return {
          scanId,
          source,
          ref,
          skills: discovered.map((skill) => ({
            name: skill.name,
            skillPath: skill.skillPath,
            description: skill.description,
            ...installStatus(skill, lock, deps.soulLoader, bundledSkills, disabledBundledSkills),
          })),
        };
      }
    );
  }

  async function audit(input: { scanId: string; name: string; skillPath?: string }) {
    const { entry, skill } = selected(input.scanId, input.name, input.skillPath);
    const deterministicScan = {
      ...scanSkill(skill.files),
      trustLevel: skillTrustLevel(entry.source),
    };
    const report = await deps.audit(skill, deterministicScan);
    entry.audited.add(skill.skillPath);
    return { report };
  }

  async function install(input: {
    scanId: string;
    names?: string[];
    paths?: string[];
    actor: CommitActor;
    source?: "agent" | "api";
  }): Promise<SkillMarketplaceInstall> {
    const entry = scans.get(input.scanId);
    if (!entry) throw new SkillMarketplaceError(404, "scan not found (it may have expired)");
    const wanted =
      input.paths !== undefined
        ? [...new Set(input.paths)].map((path) => ({
            key: path,
            matches: entry.skills.filter((skill) => skill.skillPath === path),
          }))
        : [...new Set(input.names ?? [])].map((name) => ({
            key: name,
            matches: entry.skills.filter((skill) => skill.name === name),
          }));
    if (wanted.length === 0) {
      throw new SkillMarketplaceError(400, "select at least one skill to install");
    }
    const missing = wanted.filter((want) => want.matches.length === 0).map((want) => want.key);
    if (missing.length > 0)
      throw new SkillMarketplaceError(400, `not in scan: ${missing.join(", ")}`);
    const chosen = wanted.flatMap((want) => (want.matches.length === 1 ? want.matches : []));
    const collisions = [...new Set(chosen.map((skill) => skill.name))]
      .map((name) => chosen.filter((skill) => skill.name === name))
      .filter((group) => group.length > 1);
    const ambiguous = [
      ...wanted.filter((want) => want.matches.length > 1).map((want) => want.matches),
      ...collisions,
    ];
    if (ambiguous.length > 0) {
      throw new SkillMarketplaceError(
        400,
        `this source defines more than one skill with the same name, so the selection is ambiguous: ${ambiguous
          .map(
            (matches) =>
              `${matches[0].name} (${matches.map((skill) => skill.skillPath).join(", ")})`
          )
          .join("; ")}`
      );
    }
    const unaudited = chosen.filter((skill) => !entry.audited.has(skill.skillPath));
    if (unaudited.length > 0) {
      throw new SkillMarketplaceError(
        409,
        `audit required before install: ${unaudited.map((skill) => skill.name).join(", ")}`
      );
    }
    for (const skill of chosen) validateInstallable(skill, deps.executablePackageBlocker);
    await mutateSkillsLock(deps.soulWriter, deps.gitSync.path, async (lock) => {
      const changes: SoulWrite[] = [];
      for (const skill of chosen)
        changes.push(...(await skillInstallChanges(deps.gitSync.path, skill)));
      for (const skill of chosen) {
        lock.skills[skill.name] = {
          sourceType: installedSourceType(entry.source),
          version: skillVersionFromFiles(skill.files),
          sourceUrl: stripUrlCredentials(entry.source),
          skillPath: skill.skillPath,
          ref: entry.ref,
          hash: skillDirectoryHash(skill.files),
        };
      }
      changes.push({
        op: "put",
        target: { kind: "SkillsLock" },
        content: serializeSkillsLock(lock),
      });
      return {
        subject: `soul: install skill(s) ${chosen.map((skill) => skill.name).join(", ")}`,
        source: input.source ?? "agent",
        actor: input.actor,
        businessId: DEPLOYMENT_BUSINESS_ID,
        changes,
      };
    });
    await deps.soulLoader.reload();
    return {
      installed: chosen.map((skill) => ({ name: skill.name, skillPath: skill.skillPath })),
      source: stripUrlCredentials(entry.source),
      ref: entry.ref,
    };
  }

  function selected(scanId: string, name: string, skillPath?: string) {
    const entry = scans.get(scanId);
    const skill = entry?.skills.find(
      (candidate) =>
        candidate.name === name && (skillPath === undefined || candidate.skillPath === skillPath)
    );
    if (!entry || !skill) {
      throw new SkillMarketplaceError(404, "scanned skill not found (scan may have expired)");
    }
    return { entry, skill };
  }

  /** The Skill directory a catalogue URL names, which need not equal the `name` in its frontmatter. */
  function directoryOf(skillPath: string): string {
    const segments = skillPath.split("/");
    return segments.length > 1 ? segments[segments.length - 2] : "";
  }

  async function installFromSource(input: {
    source: string;
    name?: string;
    actor: CommitActor;
    actorId: string;
    writeSource?: "agent" | "api";
  }): Promise<SkillMarketplaceSourceInstall> {
    const resolved = resolveSkillSource(input.source);
    // `scan` resolves too; passing the resolved source keeps the two paths on one spelling.
    const scanned = await scan({ source: resolved.source, actorId: input.actorId });
    const wanted = input.name ?? resolved.skillHint;

    const matches = wanted
      ? scanned.skills.filter(
          (skill) => skill.name === wanted || directoryOf(skill.skillPath) === wanted
        )
      : scanned.skills;

    if (matches.length === 0) {
      throw new SkillMarketplaceError(
        400,
        `"${wanted}" is not in ${resolved.source}. It offers: ${scanned.skills
          .map((skill) => skill.name)
          .join(", ")}`
      );
    }
    if (matches.length > 1) {
      throw new SkillMarketplaceError(
        400,
        `${resolved.source} offers more than one Skill, so name the one to install: ${matches
          .map((skill) => skill.name)
          .join(", ")}`
      );
    }

    const chosen = matches[0];
    // `install` refuses a package this flow has not audited, so the audit cannot be skipped. Note
    // it gates on having been audited, not on the verdict: a `high` report still installs, and the
    // report is returned for the caller to act on. Structural findings are the blocking set, and
    // `validateInstallable` enforces those separately.
    const { report } = await audit({
      scanId: scanned.scanId,
      name: chosen.name,
      skillPath: chosen.skillPath,
    });
    const installed = await install({
      scanId: scanned.scanId,
      names: [chosen.name],
      paths: [chosen.skillPath],
      actor: input.actor,
      source: input.writeSource,
    });
    return { ...installed, report };
  }

  return { browse, scan, audit, install, installFromSource };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function skillInstallChanges(root: string, skill: DiscoveredSkill): Promise<SoulWrite[]> {
  const changes: SoulWrite[] = [];
  const written = new Set<string>();
  const put = (path: string, content: string): void => {
    changes.push({ op: "put", target: artifactWriteTarget("Skill", skill.name, path), content });
    written.add(path);
  };
  for (const file of skill.files)
    if (file.symlinkTarget === undefined) put(file.path, file.content);
  try {
    for (const file of await collectSkillFiles(join(root, "skills", skill.name))) {
      if (!written.has(file.path)) {
        changes.push({ op: "delete", target: artifactWriteTarget("Skill", skill.name, file.path) });
      }
    }
  } catch {
    return changes;
  }
  return changes;
}

function validateInstallable(
  skill: DiscoveredSkill,
  executablePackageBlocker: (skill: DiscoveredSkill) => string | undefined
): void {
  const { frontmatter, body } = parseFrontmatter(skill.content);
  const validation = validateSkill({ name: skill.name, frontmatter, body, content: skill.content });
  if (!validation.valid) {
    throw new SkillMarketplaceError(400, `invalid Skill "${skill.name}": ${validation.error}`);
  }
  const unstorable = unstorableArtifactPaths(
    "Skill",
    skill.name,
    skill.files.filter((file) => file.symlinkTarget === undefined).map((file) => file.path)
  );
  if (unstorable.length > 0) {
    throw new SkillMarketplaceError(
      400,
      `Skill "${skill.name}" contains files the soul cannot store: ${unstorable.join(", ")}`
    );
  }
  const blockers = scanSkill(skill.files).findings.filter((finding) =>
    STRUCTURAL_INSTALL_BLOCKERS.has(finding.patternId)
  );
  if (blockers.length > 0) {
    throw new SkillMarketplaceError(
      400,
      `Skill "${skill.name}" contains unsupported package files: ${[
        ...new Set(blockers.map((finding) => finding.patternId)),
      ].join(", ")}`
    );
  }
  const executableBlocker = executablePackageBlocker(skill);
  if (executableBlocker !== undefined) {
    throw new SkillMarketplaceError(
      400,
      `Skill "${skill.name}" cannot be published: ${executableBlocker}`
    );
  }
}

function installStatus(
  skill: DiscoveredSkill,
  lock: SkillsLock,
  soulLoader: SoulLoader,
  bundledSkills: ReadonlyMap<string, BundledSkill>,
  disabledBundledSkills: ReadonlySet<string>
) {
  const installed = mergedSkills(soulLoader, bundledSkills, disabledBundledSkills).has(skill.name);
  const locked = lock.skills[skill.name];
  const lockedHash = locked?.hash;
  const legacyContentHash = createHash("sha256").update(skill.content).digest("hex");
  return {
    installed,
    updateAvailable:
      installed &&
      // A shipped Skill's lock hash describes the image, not this catalog, so comparing them would
      // offer an "update" that replaces a built-in with an unrelated same-named marketplace Skill.
      locked?.sourceType !== "bundled" &&
      !!lockedHash &&
      lockedHash !== skillDirectoryHash(skill.files) &&
      lockedHash !== legacyContentHash,
  };
}

async function readManifest(dir: string): Promise<Map<string, MarketplaceManifestEntry>> {
  const byName = new Map<string, MarketplaceManifestEntry>();
  try {
    const parsed = JSON.parse(await readFile(join(dir, "marketplace.json"), "utf8")) as {
      skills?: MarketplaceManifestEntry[];
    };
    for (const entry of Array.isArray(parsed.skills) ? parsed.skills : []) {
      for (const key of [asString(entry.skillId), asString(entry.name)]) {
        if (key && !byName.has(key)) byName.set(key, entry);
      }
    }
  } catch {
    // marketplace.json is optional metadata; discovery is authoritative without it.
  }
  return byName;
}
