import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, readlink, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { LlmService } from "@tulipfarm/llm";
import { SandboxRuntimeProfileRegistry, shellTsPythonV1 } from "@tulipfarm/sandbox";
import {
  DEFINITION_REGISTRATIONS,
  LlmNotConfiguredError,
  SchemaRegistry,
  type SkillDefinition,
  validateSkill,
} from "@tulipfarm/schema";
import {
  ALLOWED_SOURCE_HINT,
  type BundledSkill,
  cloneToTemp as cloneSourceToTemp,
  convertLegacySkill,
  DISABLED_BUNDLED_SKILLS_FILE,
  type GitSyncService,
  isAllowedSource,
  isSoulWriteError,
  mergedSkills,
  parseFrontmatter,
  persistDisabledBundledSkills,
  resolveSkill,
  type SkillScanFile,
  type SoulLoader,
  type SoulSkill,
  type SoulWrite,
  type SoulWriter,
  scanSkill,
  skillTrustLevel,
  soulWriteHttpError,
  sourceType,
} from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ActivityService } from "../../activity/service";
import type { AuditService } from "../../audit/service";
import { makeSoulAuditWriter, redactRemoteUrl, stripUrlCredentials } from "../../audit/soul-write";
import { ErrorSchema } from "../../auth/schemas";
import { commitActorFromRequest } from "../commit-actor";
import { buildAudit, SKILL_AUDIT_REPORT_SCHEMA } from "./audit";

/** Skills HTTP surface; scan/audit never installs, only explicit operator install does. */

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SCAN_TTL_MS = 10 * 60 * 1000;
const MAX_SCANS = 25;

export interface DiscoveredSkill {
  name: string;
  description?: string;
  category?: string;
  skillPath: string;
  content: string;
  // Retained after clone removal so pre-scan covers references, not just SKILL.md.
  files: SkillScanFile[];
}

interface ScanEntry {
  source: string;
  ref: string;
  skills: DiscoveredSkill[];
  // Install is gated on these audited names.
  audited: Set<string>;
  expires: number;
}

const scans = new Map<string, ScanEntry>();
const definitionRegistry = new SchemaRegistry(DEFINITION_REGISTRATIONS);

function pruneScans(now: number): void {
  for (const [id, entry] of scans) {
    if (entry.expires <= now) scans.delete(id);
  }
  while (scans.size > MAX_SCANS) {
    const oldest = scans.keys().next().value;
    if (oldest === undefined) break;
    scans.delete(oldest);
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

const STRUCTURAL_INSTALL_BLOCKERS = new Set([
  "binary_file",
  "oversized_file",
  "oversized_skill",
  "symlink_escape",
  "too_many_files",
]);

function skillDirectoryHash(files: readonly SkillScanFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function generatedSkillDefinition(skill: DiscoveredSkill): string | undefined {
  if (skill.files.some((file) => file.path === "skill.yaml" || file.path === "skill.yml")) {
    return undefined;
  }
  const { frontmatter, body } = parseFrontmatter(skill.content);
  const paths = skill.files.map((file) => file.path);
  const result = convertLegacySkill({
    name: skill.name,
    body,
    frontmatter: {
      ...frontmatter,
      trustTier: frontmatter.trustTier ?? "third_party",
      references: paths.filter((path) => path.startsWith("references/")),
      assets: paths.filter((path) => path.startsWith("assets/")),
      schemas: paths.filter((path) => path.startsWith("schemas/")),
      scripts: paths.filter((path) => path.startsWith("scripts/")),
    },
  });
  const definition = result.files.find((file) => file.path.endsWith("/skill.yaml"));
  return definition?.operation === "upsert" ? definition.content : undefined;
}

/**
 * The file changes that install `skill` over whatever is already at `skills/<name>`.
 *
 * Install is replace, not merge: a re-install from a source that dropped a reference must not
 * leave the old one behind. The staging-directory-then-rename dance this replaced achieved that
 * by removing the destination first; here the stale files are named explicitly so the whole
 * install is one changeset the gateway can commit or refuse as a unit.
 */
async function skillInstallChanges(root: string, skill: DiscoveredSkill): Promise<SoulWrite[]> {
  const changes: SoulWrite[] = [];
  const written = new Set<string>();
  const put = (path: string, content: string): void => {
    changes.push({
      op: "put",
      target: { kind: "Skill", slug: skill.name, companion: path },
      content,
    });
    written.add(path);
  };

  for (const file of skill.files) {
    if (file.symlinkTarget !== undefined) continue;
    put(file.path, file.content);
  }
  const generated = generatedSkillDefinition(skill);
  if (generated !== undefined) {
    changes.push({
      op: "put",
      target: { kind: "Skill", slug: skill.name },
      content: generated,
    });
    written.add("skill.yaml");
  }

  let existing: SkillScanFile[];
  try {
    existing = await collectSkillFiles(join(root, "skills", skill.name));
  } catch {
    // No prior install to supersede.
    return changes;
  }
  for (const file of existing) {
    if (written.has(file.path)) continue;
    changes.push({
      op: "delete",
      target:
        file.path === "skill.yaml"
          ? { kind: "Skill", slug: skill.name }
          : { kind: "Skill", slug: skill.name, companion: file.path },
    });
  }
  return changes;
}

interface SkillPackageDetail {
  readonly files: readonly { path: string; size: number }[];
  readonly commands: readonly {
    name: string;
    toolRef: string;
    runtimeProfile: string;
    entrypoint: string;
    requiredCommands: readonly string[];
    runtimeAvailable: boolean;
    blocker?: string;
  }[];
}

function runtimeStatus(
  runtimeProfile: string,
  requiredCommands: readonly string[]
): { runtimeAvailable: boolean; blocker?: string } {
  if (process.env.NODE_ENV === "production") {
    return {
      runtimeAvailable: false,
      blocker: "an attested production sandbox backend is not configured",
    };
  }
  const configuredImage = process.env.SANDBOX_RUNTIME_IMAGE;
  const digest =
    process.env.SANDBOX_RUNTIME_IMAGE_DIGEST ??
    configuredImage?.match(/@(sha256:[0-9a-f]{64})$/)?.[1];
  if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    return {
      runtimeAvailable: false,
      blocker: "sandbox runtime image digest is not configured",
    };
  }
  const registry = new SandboxRuntimeProfileRegistry([shellTsPythonV1(digest)]);
  try {
    registry.require(runtimeProfile, requiredCommands);
    return { runtimeAvailable: true };
  } catch (error) {
    return {
      runtimeAvailable: false,
      blocker: error instanceof Error ? error.message : "sandbox runtime is unavailable",
    };
  }
}

async function skillPackageDetail(directory: string | undefined): Promise<SkillPackageDetail> {
  if (directory === undefined) return { files: [], commands: [] };
  let files: SkillScanFile[];
  try {
    files = await collectSkillFiles(directory);
  } catch {
    return { files: [], commands: [] };
  }
  const definitionFile = files.find(
    (file) => file.path === "skill.yaml" || file.path === "skill.yml"
  );
  let definition: SkillDefinition | undefined;
  if (definitionFile !== undefined) {
    try {
      definition = definitionRegistry.validateYaml(definitionFile.content)
        .document as unknown as SkillDefinition;
    } catch {
      // A malformed skill.yaml is reported to the operator as an unreadable definition, not here.
    }
  }
  return {
    files: files.map((file) => ({ path: file.path, size: file.size ?? 0 })),
    commands: (definition?.spec.commands ?? []).map((command) => ({
      name: command.name,
      toolRef: command.toolRef,
      runtimeProfile: command.runtimeProfile,
      entrypoint: command.entrypoint,
      requiredCommands: command.requiredCommands ?? [],
      ...runtimeStatus(command.runtimeProfile, command.requiredCommands ?? []),
    })),
  };
}

function executablePackageBlocker(skill: DiscoveredSkill): string | undefined {
  const definitionFile = skill.files.find(
    (file) => file.path === "skill.yaml" || file.path === "skill.yml"
  );
  if (definitionFile === undefined) return undefined;
  let definition: SkillDefinition;
  try {
    definition = definitionRegistry.validateYaml(definitionFile.content)
      .document as unknown as SkillDefinition;
  } catch (error) {
    return error instanceof Error ? error.message : "invalid skill definition";
  }
  const paths = new Set(skill.files.map((file) => file.path));
  for (const command of definition.spec.commands ?? []) {
    if (!paths.has(command.entrypoint)) {
      return `command ${command.name} entrypoint is not present in the Skill package`;
    }
    const status = runtimeStatus(command.runtimeProfile, command.requiredCommands ?? []);
    if (!status.runtimeAvailable) {
      return `command ${command.name}: ${status.blocker ?? "sandbox runtime is unavailable"}`;
    }
    if ((command.integrationBindings?.length ?? 0) > 1) {
      return `command ${command.name} declares more than one Integration credential`;
    }
  }
  return undefined;
}
function categoryFromSkillPath(skillPath: string): string | undefined {
  const parts = skillPath.split(/[\\/]/).slice(0, -2);
  if (parts[0] === "skills") parts.shift();
  return parts[0];
}

async function collectSkillFiles(skillDirectory: string): Promise<SkillScanFile[]> {
  const files: SkillScanFile[] = [];
  const root = await realpath(skillDirectory);

  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 6) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = join(directory, entry.name);
      const path = relative(skillDirectory, full);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isSymbolicLink()) {
        const symlinkTarget = await readlink(full);
        let symlinkEscapes = true;
        try {
          const resolved = await realpath(full);
          const fromRoot = relative(root, resolved);
          symlinkEscapes = fromRoot.startsWith("..") || isAbsolute(fromRoot);
        } catch {
          // Fail closed: an unresolvable symlink stays flagged as escaping the root.
        }
        files.push({
          path,
          content: symlinkTarget,
          size: Buffer.byteLength(symlinkTarget),
          symlinkTarget,
          symlinkEscapes,
        });
      } else if (entry.isFile()) {
        const content = await readFile(full);
        files.push({ path, content: content.toString("utf8"), size: content.byteLength });
      }
    }
  }

  await walk(skillDirectory, 0);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/** Walks for SKILL.md files; unsafe directory names are skipped before install. */
export async function discoverSkills(root: string): Promise<DiscoveredSkill[]> {
  const out: DiscoveredSkill[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 6) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.name === "SKILL.md") {
        const content = await readFile(full, "utf8");
        const { frontmatter } = parseFrontmatter(content);
        const name = basename(dirname(full));
        if (!NAME_RE.test(name)) continue;
        out.push({
          name,
          description: asString(frontmatter.description),
          category: categoryFromSkillPath(relative(root, full)),
          skillPath: relative(root, full),
          content,
          files: await collectSkillFiles(dirname(full)),
        });
      }
    }
  }
  await walk(root, 0);
  return out;
}

interface LockEntry {
  sourceUrl?: string;
  sourceType?: string;
  skillPath?: string;
  ref?: string;
  hash?: string;
}

async function readLock(soulPath: string): Promise<{
  version: number;
  skills: Record<string, LockEntry>;
}> {
  try {
    const parsed = JSON.parse(await readFile(join(soulPath, "skills-lock.json"), "utf8")) as {
      version?: number;
      skills?: Record<string, LockEntry>;
    };
    return { version: parsed.version ?? 1, skills: parsed.skills ?? {} };
  } catch {
    return { version: 1, skills: {} };
  }
}

function toSkillSummary(
  skill: SoulSkill,
  lock: Awaited<ReturnType<typeof readLock>>,
  bundledOnly = false
): {
  name: string;
  description?: string;
  provenance: "builtin" | "marketplace" | "user";
  source?: string;
  pendingAudit: boolean;
} {
  const locked = lock.skills[skill.name];
  return {
    name: skill.name,
    description: asString(skill.frontmatter.description),
    provenance: bundledOnly ? "builtin" : locked ? "marketplace" : "user",
    source: locked?.sourceUrl,
    pendingAudit: skill.frontmatter._pendingAudit === true,
  };
}

// V1 SKILL.md-only lock hashes stay accepted until that Skill is updated.
function installStatus(
  skill: DiscoveredSkill,
  lock: Awaited<ReturnType<typeof readLock>>,
  soulLoader: SoulLoader,
  bundledSkills: ReadonlyMap<string, BundledSkill> = new Map(),
  disabledBundledSkills: ReadonlySet<string> = new Set()
): { installed: boolean; updateAvailable: boolean } {
  const installed = mergedSkills(soulLoader, bundledSkills, disabledBundledSkills).has(skill.name);
  const lockedHash = lock.skills[skill.name]?.hash;
  const legacyContentHash = createHash("sha256").update(skill.content).digest("hex");
  const updateAvailable =
    installed &&
    !!lockedHash &&
    lockedHash !== skillDirectoryHash(skill.files) &&
    lockedHash !== legacyContentHash;
  return { installed, updateAvailable };
}

// Marketplace manifest only enriches discovered SKILL.md files.
interface MarketplaceManifestEntry {
  skillId?: string;
  name?: string;
  description?: string;
  category?: string;
  installs?: number;
}

function marketplaceSource(): string {
  return process.env.MARKETPLACE_SOURCE ?? "tulipfarm/skills";
}

interface MarketplaceResponse {
  scanId: string;
  source: string;
  skills: {
    name: string;
    skillId?: string;
    description?: string;
    category?: string;
    installs?: number;
    installed: boolean;
    updateAvailable: boolean;
  }[];
}

const marketplaceCache = new Map<
  string,
  { scanId: string; expires: number; manifest: Map<string, MarketplaceManifestEntry> }
>();

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

async function loadMarketplace(
  gitSync: GitSyncService,
  soulLoader: SoulLoader,
  bundledSkills: ReadonlyMap<string, BundledSkill>,
  disabledBundledSkills: ReadonlySet<string>
): Promise<MarketplaceResponse> {
  const source = marketplaceSource();
  const now = Date.now();
  const cached = marketplaceCache.get(source);
  const cachedScan = cached ? scans.get(cached.scanId) : undefined;
  if (cached && cached.expires > now && cachedScan) {
    const lock = await readLock(gitSync.path);
    return {
      scanId: cached.scanId,
      source,
      skills: cachedScan.skills.map((skill) => {
        const meta = cached.manifest.get(skill.name);
        const status = installStatus(skill, lock, soulLoader, bundledSkills, disabledBundledSkills);
        return {
          name: skill.name,
          skillId: asString(meta?.skillId),
          description: skill.description ?? asString(meta?.description),
          category: skill.category ?? asString(meta?.category),
          installs: typeof meta?.installs === "number" ? meta.installs : undefined,
          installed: status.installed,
          updateAvailable: status.updateAvailable && lock.skills[skill.name]?.sourceUrl === source,
        };
      }),
    };
  }

  let dir: string | undefined;
  try {
    const clone = await cloneSourceToTemp(source, "skill-scan-");
    dir = clone.dir;
    const discovered = await discoverSkills(dir);
    const manifest = await readManifest(dir);
    const scanId = randomUUID();
    pruneScans(now);
    scans.set(scanId, {
      source,
      ref: clone.ref,
      skills: discovered,
      audited: new Set(),
      expires: now + SCAN_TTL_MS,
    });
    marketplaceCache.set(source, {
      scanId,
      expires: now + SCAN_TTL_MS,
      manifest,
    });
    return loadMarketplace(gitSync, soulLoader, bundledSkills, disabledBundledSkills);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

const SummaryProps = {
  name: { type: "string" },
  description: { type: "string" },
  provenance: { type: "string", enum: ["builtin", "marketplace", "user"] },
  source: { type: "string" },
  pendingAudit: { type: "boolean" },
} as const;

const MarketplaceSkillProps = {
  name: { type: "string" },
  skillId: { type: "string" },
  description: { type: "string" },
  category: { type: "string" },
  installs: { type: "number" },
  installed: { type: "boolean" },
  updateAvailable: { type: "boolean" },
} as const;

export function registerSkillRoutes(
  app: FastifyInstance,
  soulLoader: SoulLoader,
  gitSync: GitSyncService,
  soulWriter: SoulWriter,
  llmService: LlmService,
  requireAuth: PreHandler,
  activity?: ActivityService,
  bundledSkills: ReadonlyMap<string, BundledSkill> = new Map(),
  disabledBundledSkills: Set<string> = new Set(),
  // Audit answers who changed Agents' capabilities.
  audit?: AuditService
): void {
  const auditWrite = makeSoulAuditWriter(audit);
  app.get(
    "/api/v1/skills",
    {
      preHandler: requireAuth,
      schema: {
        description: "List Soul and bundled Skills with provenance.",
        tags: ["skills"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            required: ["skills"],
            properties: {
              skills: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name", "provenance", "pendingAudit"],
                  properties: SummaryProps,
                },
              },
            },
          },
          401: ErrorSchema,
        },
      },
    },
    async () => {
      const lock = await readLock(gitSync.path);
      const skills = Array.from(
        mergedSkills(soulLoader, bundledSkills, disabledBundledSkills).values()
      ).map((skill) => toSkillSummary(skill, lock, !soulLoader.skills.has(skill.name)));
      return { skills };
    }
  );

  app.get(
    "/api/v1/skills/marketplace",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Browse the official skills marketplace (TulipFarm/skills). Returns a scanId usable with the audit and install endpoints.",
        tags: ["skills"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            required: ["scanId", "source", "skills"],
            properties: {
              scanId: { type: "string" },
              source: { type: "string" },
              skills: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name", "installed", "updateAvailable"],
                  properties: MarketplaceSkillProps,
                },
              },
            },
          },
          401: ErrorSchema,
          502: ErrorSchema,
        },
      },
    },
    async (_req, reply) => {
      reply.header("cache-control", "no-store");
      try {
        return await loadMarketplace(gitSync, soulLoader, bundledSkills, disabledBundledSkills);
      } catch (e) {
        return reply.code(502).send({
          error: `marketplace unavailable: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
  );

  app.get(
    "/api/v1/skills/updates",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "List installed marketplace Skills whose locked content hash differs from the current catalog.",
        tags: ["skills"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            required: ["scanId", "source", "skills"],
            properties: {
              scanId: { type: "string" },
              source: { type: "string" },
              skills: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name", "installed", "updateAvailable"],
                  properties: MarketplaceSkillProps,
                },
              },
            },
          },
          401: ErrorSchema,
          502: ErrorSchema,
        },
      },
    },
    async (_req, reply) => {
      reply.header("cache-control", "no-store");
      try {
        const marketplace = await loadMarketplace(
          gitSync,
          soulLoader,
          bundledSkills,
          disabledBundledSkills
        );
        return {
          ...marketplace,
          skills: marketplace.skills.filter((skill) => skill.updateAvailable),
        };
      } catch (e) {
        return reply.code(502).send({
          error: `marketplace unavailable: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
  );

  app.get(
    "/api/v1/skills/:name",
    {
      preHandler: requireAuth,
      schema: {
        description: "Get a single skill including its SKILL.md markdown body.",
        tags: ["skills"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        response: {
          200: {
            type: "object",
            required: ["name", "provenance", "body", "pendingAudit", "files", "commands"],
            properties: {
              ...SummaryProps,
              body: { type: "string" },
              files: {
                type: "array",
                items: {
                  type: "object",
                  required: ["path", "size"],
                  properties: { path: { type: "string" }, size: { type: "integer" } },
                },
              },
              commands: {
                type: "array",
                items: {
                  type: "object",
                  required: [
                    "name",
                    "toolRef",
                    "runtimeProfile",
                    "entrypoint",
                    "requiredCommands",
                    "runtimeAvailable",
                  ],
                  properties: {
                    name: { type: "string" },
                    toolRef: { type: "string" },
                    runtimeProfile: { type: "string" },
                    entrypoint: { type: "string" },
                    requiredCommands: { type: "array", items: { type: "string" } },
                    runtimeAvailable: { type: "boolean" },
                    blocker: { type: "string" },
                  },
                },
              },
            },
          },
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      const skill = resolveSkill(name, soulLoader, bundledSkills, disabledBundledSkills);
      if (!skill) return reply.code(404).send({ error: `skill not found: ${name}` });
      const lock = await readLock(gitSync.path);
      const bundled = bundledSkills.get(name);
      const directory = soulLoader.skills.has(name)
        ? join(gitSync.path, "skills", name)
        : bundled?.directory;
      return {
        ...toSkillSummary(skill, lock, !soulLoader.skills.has(name)),
        body: skill.body,
        ...(await skillPackageDetail(directory)),
      };
    }
  );

  app.delete(
    "/api/v1/skills/:name",
    {
      preHandler: requireAuth,
      schema: {
        description: "Remove an installed skill from the soul repo (and its skills-lock entry).",
        tags: ["skills"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        response: {
          204: { type: "null" },
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          422: ErrorSchema,
          500: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      if (
        !NAME_RE.test(name) ||
        !resolveSkill(name, soulLoader, bundledSkills, disabledBundledSkills)
      ) {
        return reply.code(404).send({ error: `skill not found: ${name}` });
      }
      const lock = await readLock(gitSync.path);
      delete lock.skills[name];
      const changes: SoulWrite[] = [];
      if (soulLoader.skills.has(name)) {
        changes.push({ op: "deleteArtifact", kind: "Skill", slug: name });
      }
      changes.push({
        op: "put",
        target: { kind: "SkillsLock" },
        content: `${JSON.stringify(lock, null, 2)}\n`,
      });
      try {
        await soulWriter.apply({
          subject: `soul: remove skill ${name}`,
          source: "api",
          actor: commitActorFromRequest(req),
          businessId: DEPLOYMENT_BUSINESS_ID,
          changes,
        });
      } catch (e) {
        if (isSoulWriteError(e)) {
          const mapped = soulWriteHttpError(e);
          return reply.code(mapped.status).send(mapped.body);
        }
        throw e;
      }
      // The bundled-overlay tombstone is not an addressable Soul artifact — it records which
      // *shipped* Skills are switched off, not authored content — so it cannot ride the changeset
      // above. `commitPaths` still stages it explicitly rather than with `git add -A`.
      if (bundledSkills.has(name)) {
        disabledBundledSkills.add(name);
        await persistDisabledBundledSkills(gitSync.path, disabledBundledSkills);
        await gitSync.commitPaths(
          `soul: disable bundled skill ${name}`,
          [join("skills", DISABLED_BUNDLED_SKILLS_FILE)],
          commitActorFromRequest(req)
        );
      }
      await soulLoader.reload();
      await auditWrite(req, "skill.remove", `skill:${name}`, {
        bundled: bundledSkills.has(name),
      });
      return reply.code(204).send();
    }
  );

  app.post(
    "/api/v1/skills/scan",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Clone a git repo (source accepts an optional #branch suffix) and discover installable SKILL.md files.",
        tags: ["skills"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          required: ["source"],
          additionalProperties: false,
          properties: { source: { type: "string", minLength: 1 } },
        },
        response: {
          200: {
            type: "object",
            required: ["scanId", "skills"],
            properties: {
              scanId: { type: "string" },
              skills: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name", "installed", "updateAvailable"],
                  properties: {
                    name: { type: "string" },
                    description: { type: "string" },
                    installed: { type: "boolean" },
                    updateAvailable: { type: "boolean" },
                  },
                },
              },
            },
          },
          400: ErrorSchema,
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { source } = req.body as { source: string };
      if (!isAllowedSource(source)) {
        return reply.code(400).send({ error: ALLOWED_SOURCE_HINT });
      }
      let dir: string | undefined;
      try {
        const clone = await cloneSourceToTemp(source, "skill-scan-");
        dir = clone.dir;
        const discovered = await discoverSkills(dir);
        if (discovered.length === 0) {
          return reply.code(400).send({ error: "no SKILL.md files found in repo" });
        }
        const lock = await readLock(gitSync.path);
        const scanId = randomUUID();
        pruneScans(Date.now());
        scans.set(scanId, {
          source,
          ref: clone.ref,
          skills: discovered,
          audited: new Set(),
          expires: Date.now() + SCAN_TTL_MS,
        });
        return {
          scanId,
          skills: discovered.map((s) => ({
            name: s.name,
            description: s.description,
            ...installStatus(s, lock, soulLoader, bundledSkills, disabledBundledSkills),
          })),
        };
      } catch (e) {
        return reply
          .code(400)
          .send({ error: `scan failed: ${e instanceof Error ? e.message : String(e)}` });
      } finally {
        if (dir) await rm(dir, { recursive: true, force: true });
      }
    }
  );

  app.post(
    "/api/v1/skills/audit",
    {
      preHandler: requireAuth,
      schema: {
        description: "Run the advisory SkillAudit review on a scanned skill.",
        tags: ["skills"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          required: ["scanId", "name"],
          additionalProperties: false,
          properties: { scanId: { type: "string" }, name: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["report"],
            properties: { report: SKILL_AUDIT_REPORT_SCHEMA },
          },
          401: ErrorSchema,
          404: ErrorSchema,
          422: ErrorSchema,
          502: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { scanId, name } = req.body as { scanId: string; name: string };
      const entry = scans.get(scanId);
      const skill = entry?.skills.find((s) => s.name === name);
      if (!entry || !skill)
        return reply.code(404).send({ error: "scanned skill not found (scan may have expired)" });
      const { body } = parseFrontmatter(skill.content);
      const deterministicScan = {
        ...scanSkill(skill.files),
        trustLevel: skillTrustLevel(entry.source),
      };
      let report: Awaited<ReturnType<typeof buildAudit>>;
      try {
        report = await buildAudit(
          llmService.effortModel("balanced"),
          {
            name: skill.name,
            description: skill.description,
            body,
          },
          deterministicScan
        );
      } catch (e) {
        // Missing LLM config is 422; other audit failures are upstream 502s.
        if (e instanceof LlmNotConfiguredError) {
          return reply.code(422).send({
            error:
              "SkillAudit needs an LLM provider — configure one in Operate → Business → Models.",
          });
        }
        return reply
          .code(502)
          .send({ error: `SkillAudit failed: ${e instanceof Error ? e.message : String(e)}` });
      }
      entry.audited.add(name);
      return { report };
    }
  );

  app.post(
    "/api/v1/skills/install",
    {
      preHandler: requireAuth,
      schema: {
        description: "Operator confirm: install the named scanned skills into the soul repo.",
        tags: ["skills"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          required: ["scanId", "names"],
          additionalProperties: false,
          properties: {
            scanId: { type: "string" },
            names: { type: "array", items: { type: "string" }, minItems: 1 },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["installed"],
            properties: { installed: { type: "array", items: { type: "string" } } },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          422: ErrorSchema,
          500: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { scanId, names } = req.body as { scanId: string; names: string[] };
      const entry = scans.get(scanId);
      if (!entry) return reply.code(404).send({ error: "scan not found (it may have expired)" });

      const unique = [...new Set(names)];
      const chosen = unique.map((n) => entry.skills.find((s) => s.name === n));
      const missing = unique.filter((_, i) => !chosen[i]);
      if (missing.length > 0)
        return reply.code(400).send({ error: `not in scan: ${missing.join(", ")}` });

      // SkillAudit must run before install; rating itself never blocks.
      const unaudited = unique.filter((n) => !entry.audited.has(n));
      if (unaudited.length > 0)
        return reply
          .code(409)
          .send({ error: `audit required before install: ${unaudited.join(", ")}` });

      for (const skill of chosen as DiscoveredSkill[]) {
        const { frontmatter, body } = parseFrontmatter(skill.content);
        const validation = validateSkill({
          name: skill.name,
          frontmatter,
          body,
          content: skill.content,
        });
        if (!validation.valid) {
          return reply
            .code(400)
            .send({ error: `invalid Skill "${skill.name}": ${validation.error}` });
        }
        const blockers = scanSkill(skill.files).findings.filter((finding) =>
          STRUCTURAL_INSTALL_BLOCKERS.has(finding.patternId)
        );
        if (blockers.length > 0) {
          return reply.code(400).send({
            error: `Skill "${skill.name}" contains unsupported package files: ${[
              ...new Set(blockers.map((finding) => finding.patternId)),
            ].join(", ")}`,
          });
        }
        const executableBlocker = executablePackageBlocker(skill);
        if (executableBlocker !== undefined) {
          return reply.code(400).send({
            error: `Skill "${skill.name}" cannot be published: ${executableBlocker}`,
          });
        }
      }

      const installed: string[] = [];
      const changes: SoulWrite[] = [];
      for (const skill of chosen as DiscoveredSkill[]) {
        changes.push(...(await skillInstallChanges(gitSync.path, skill)));
        installed.push(skill.name);
      }

      const lock = await readLock(gitSync.path);
      for (const skill of chosen as DiscoveredSkill[]) {
        lock.skills[skill.name] = {
          // Strip credentials before committing/serving provenance; keep file:// and owner/repo.
          sourceUrl: stripUrlCredentials(entry.source),
          sourceType: sourceType(entry.source),
          skillPath: skill.skillPath,
          ref: entry.ref,
          hash: skillDirectoryHash(skill.files),
        };
      }
      changes.push({
        op: "put",
        target: { kind: "SkillsLock" },
        content: `${JSON.stringify(lock, null, 2)}\n`,
      });

      try {
        await soulWriter.apply({
          subject: `soul: install skill(s) ${installed.join(", ")}`,
          source: "api",
          actor: commitActorFromRequest(req),
          businessId: DEPLOYMENT_BUSINESS_ID,
          changes,
        });
      } catch (e) {
        if (isSoulWriteError(e)) {
          const mapped = soulWriteHttpError(e);
          return reply.code(mapped.status).send(mapped.body);
        }
        throw e;
      }
      await soulLoader.reload();
      await activity?.record({
        category: "skill",
        action: "skill.installed",
        actorId: (req.user as { _id: string } | undefined)?._id,
        targetType: "skill",
        targetId: installed.join(", "),
        summary: `Installed skill(s): ${installed.join(", ")}`,
        metadata: {
          skills: installed,
          source: stripUrlCredentials(entry.source),
          ref: entry.ref,
        },
      });
      await auditWrite(req, "skill.install", `skill:${installed.join(",")}`, {
        skills: installed,
        // The ledger is permanent; strip credentials from pasted clone URLs.
        source: redactRemoteUrl(entry.source),
        ...(entry.ref ? { ref: entry.ref } : {}),
      });
      return { installed };
    }
  );
}
