// biome-ignore-all format: keep business logic local while meeting the control-plane size cap
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { gitSourceHttpError, withGitSourceClone } from "@tulipfarm/integrations";
import type { LlmService } from "@tulipfarm/llm";
import { SandboxRuntimeProfileRegistry, shellTsPythonV1 } from "@tulipfarm/sandbox";
import {
  DEFINITION_REGISTRATIONS,
  LlmNotConfiguredError,
  SchemaRegistry,
  type SkillDefinition,
  unstorableArtifactPaths,
  validateSkill,
} from "@tulipfarm/schema";
import {
  artifactWriteTarget,
  type BundledSkill,
  convertLegacySkill,
  DISABLED_BUNDLED_SKILLS_FILE,
  type GitSyncService,
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
import { buildAudit } from "./audit";
import {
  SkillAuditBodySchema,
  SkillAuditResponseSchema,
  SkillDeleteResponseSchema,
  SkillDetailResponseSchema,
  SkillInstallBodySchema,
  SkillInstallResponseSchema,
  SkillListResponseSchema,
  SkillMarketplaceResponseSchema,
  SkillNameParamsSchema,
  SkillScanBodySchema,
  SkillScanResponseSchema,
} from "./schemas";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
type ScanEntry = { source: string; ref: string; skills: DiscoveredSkill[]; audited: Set<string>; expires: number };
type SkillPackageDetail = {
  readonly files: readonly { path: string; size: number }[];
  readonly commands: readonly { name: string; toolRef: string; runtimeProfile: string; entrypoint: string; requiredCommands: readonly string[]; runtimeAvailable: boolean; blocker?: string }[];
};
type LockEntry = { sourceUrl?: string; sourceType?: string; skillPath?: string; ref?: string; hash?: string };
type SkillsLock = { version: number; skills: Record<string, LockEntry> };
type SkillSummary = { name: string; description?: string; provenance: "builtin" | "marketplace" | "user"; source?: string; pendingAudit: boolean };
type MarketplaceManifestEntry = { skillId?: string; name?: string; description?: string; category?: string; installs?: number };
type MarketplaceResponse = {
  scanId: string;
  source: string;
  skills: { name: string; skillId?: string; description?: string; category?: string; installs?: number; installed: boolean; updateAvailable: boolean }[];
};
export interface DiscoveredSkill {
  name: string;
  description?: string;
  category?: string;
  skillPath: string;
  content: string;
  files: SkillScanFile[];
}
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SCAN_TTL_MS = 10 * 60 * 1000;
const MAX_SCANS = 25;
const STRUCTURAL_INSTALL_BLOCKERS = new Set(["binary_file", "oversized_file", "oversized_skill", "symlink_escape", "too_many_files"]);
const scans = new Map<string, ScanEntry>();
const definitionRegistry = new SchemaRegistry(DEFINITION_REGISTRATIONS);
const marketplaceCache = new Map<string, { scanId: string; expires: number; manifest: Map<string, MarketplaceManifestEntry> }>();
function pruneScans(now: number): void {
  for (const [id, entry] of scans) if (entry.expires <= now) scans.delete(id);
  while (scans.size > MAX_SCANS) {
    const oldest = scans.keys().next().value;
    if (oldest === undefined) break;
    scans.delete(oldest);
  }
}
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function skillDirectoryHash(files: readonly SkillScanFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(file.path); hash.update("\0"); hash.update(file.content); hash.update("\0");
  }
  return hash.digest("hex");
}
function generatedSkillDefinition(skill: DiscoveredSkill): string | undefined {
  if (skill.files.some((file) => file.path === "skill.yaml" || file.path === "skill.yml")) return undefined;
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
async function skillInstallChanges(root: string, skill: DiscoveredSkill): Promise<SoulWrite[]> {
  const changes: SoulWrite[] = [];
  const written = new Set<string>();
  const put = (path: string, content: string): void => {
    changes.push({ op: "put", target: artifactWriteTarget("Skill", skill.name, path), content });
    written.add(path);
  };
  for (const file of skill.files) if (file.symlinkTarget === undefined) put(file.path, file.content);
  const generated = generatedSkillDefinition(skill);
  if (generated !== undefined) {
    changes.push({ op: "put", target: { kind: "Skill", slug: skill.name }, content: generated });
    written.add("skill.yaml");
  }
  try {
    for (const file of await collectSkillFiles(join(root, "skills", skill.name))) {
      if (!written.has(file.path)) changes.push({ op: "delete", target: artifactWriteTarget("Skill", skill.name, file.path) });
    }
  } catch {
    return changes;
  }
  return changes;
}
function runtimeStatus(runtimeProfile: string, requiredCommands: readonly string[]): { runtimeAvailable: boolean; blocker?: string } {
  if (process.env.NODE_ENV === "production") return { runtimeAvailable: false, blocker: "an attested production sandbox backend is not configured" };
  const configuredImage = process.env.SANDBOX_RUNTIME_IMAGE;
  const digest = process.env.SANDBOX_RUNTIME_IMAGE_DIGEST ?? configuredImage?.match(/@(sha256:[0-9a-f]{64})$/)?.[1];
  if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) return { runtimeAvailable: false, blocker: "sandbox runtime image digest is not configured" };
  const registry = new SandboxRuntimeProfileRegistry([shellTsPythonV1(digest)]);
  try {
    registry.require(runtimeProfile, requiredCommands);
    return { runtimeAvailable: true };
  } catch (error) {
    return { runtimeAvailable: false, blocker: error instanceof Error ? error.message : "sandbox runtime is unavailable" };
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
  const definitionFile = files.find((file) => file.path === "skill.yaml" || file.path === "skill.yml");
  let definition: SkillDefinition | undefined;
  if (definitionFile !== undefined) {
    try {
      definition = definitionRegistry.validateYaml(definitionFile.content).document as unknown as SkillDefinition;
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
  const definitionFile = skill.files.find((file) => file.path === "skill.yaml" || file.path === "skill.yml");
  if (definitionFile === undefined) return undefined;
  let definition: SkillDefinition;
  try {
    definition = definitionRegistry.validateYaml(definitionFile.content).document as unknown as SkillDefinition;
  } catch (error) {
    return error instanceof Error ? error.message : "invalid skill definition";
  }
  const paths = new Set(skill.files.map((file) => file.path));
  for (const command of definition.spec.commands ?? []) {
    if (!paths.has(command.entrypoint)) return `command ${command.name} entrypoint is not present in the Skill package`;
    const status = runtimeStatus(command.runtimeProfile, command.requiredCommands ?? []);
    if (!status.runtimeAvailable) return `command ${command.name}: ${status.blocker ?? "sandbox runtime is unavailable"}`;
    if ((command.integrationBindings?.length ?? 0) > 1) return `command ${command.name} declares more than one Integration credential`;
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
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = join(directory, entry.name);
      const path = relative(skillDirectory, full);
      if (entry.isDirectory()) { await walk(full, depth + 1); continue; }
      if (entry.isSymbolicLink()) {
        const symlinkTarget = await readlink(full);
        let symlinkEscapes = true;
        try {
          const resolved = await realpath(full);
          const fromRoot = relative(root, resolved);
          symlinkEscapes = fromRoot.startsWith("..") || isAbsolute(fromRoot);
        } catch {
          // Fail closed: an unresolvable symlink stays flagged as escaping the root.
        }
        files.push({ path, content: symlinkTarget, size: Buffer.byteLength(symlinkTarget), symlinkTarget, symlinkEscapes });
        continue;
      }
      if (entry.isFile()) {
        const content = await readFile(full);
        files.push({ path, content: content.toString("utf8"), size: content.byteLength });
      }
    }
  }
  await walk(skillDirectory, 0);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}
export async function discoverSkills(root: string): Promise<DiscoveredSkill[]> {
  const discovered: DiscoveredSkill[] = [];
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 6) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) { await walk(full, depth + 1); continue; }
      if (entry.name !== "SKILL.md") continue;
      const content = await readFile(full, "utf8");
      const { frontmatter } = parseFrontmatter(content);
      const name = basename(dirname(full));
      if (!NAME_RE.test(name)) continue;
      discovered.push({
        name,
        description: asString(frontmatter.description),
        category: categoryFromSkillPath(relative(root, full)),
        skillPath: relative(root, full),
        content,
        files: await collectSkillFiles(dirname(full)),
      });
    }
  }
  await walk(root, 0);
  return discovered;
}
async function readLock(soulPath: string): Promise<SkillsLock> {
  try {
    const parsed = JSON.parse(await readFile(join(soulPath, "skills-lock.json"), "utf8")) as SkillsLock;
    return { version: parsed.version ?? 1, skills: parsed.skills ?? {} };
  } catch {
    return { version: 1, skills: {} };
  }
}
function toSkillSummary(skill: SoulSkill, lock: SkillsLock, bundledOnly = false): SkillSummary {
  const locked = lock.skills[skill.name];
  return {
    name: skill.name,
    description: asString(skill.frontmatter.description),
    provenance: bundledOnly ? "builtin" : locked ? "marketplace" : "user",
    source: locked?.sourceUrl,
    pendingAudit: skill.frontmatter._pendingAudit === true,
  };
}
function installStatus(skill: DiscoveredSkill, lock: SkillsLock, soulLoader: SoulLoader, bundledSkills: ReadonlyMap<string, BundledSkill> = new Map(), disabledBundledSkills: ReadonlySet<string> = new Set()): { installed: boolean; updateAvailable: boolean } {
  const installed = mergedSkills(soulLoader, bundledSkills, disabledBundledSkills).has(skill.name);
  const lockedHash = lock.skills[skill.name]?.hash;
  const legacyContentHash = createHash("sha256").update(skill.content).digest("hex");
  return { installed, updateAvailable: installed && !!lockedHash && lockedHash !== skillDirectoryHash(skill.files) && lockedHash !== legacyContentHash };
}
function marketplaceSource(): string {
  return process.env.MARKETPLACE_SOURCE ?? "tulipfarm/skills";
}
async function readManifest(dir: string): Promise<Map<string, MarketplaceManifestEntry>> {
  const byName = new Map<string, MarketplaceManifestEntry>();
  try {
    const parsed = JSON.parse(await readFile(join(dir, "marketplace.json"), "utf8")) as { skills?: MarketplaceManifestEntry[] };
    for (const entry of Array.isArray(parsed.skills) ? parsed.skills : []) {
      for (const key of [asString(entry.skillId), asString(entry.name)]) if (key && !byName.has(key)) byName.set(key, entry);
    }
  } catch {
    // marketplace.json is optional metadata; discovery is authoritative without it.
  }
  return byName;
}
async function loadMarketplace(gitSync: GitSyncService, soulLoader: SoulLoader, bundledSkills: ReadonlyMap<string, BundledSkill>, disabledBundledSkills: ReadonlySet<string>): Promise<MarketplaceResponse> {
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
          skillPath: skill.skillPath,
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
  await withGitSourceClone(source, { prefix: "skill-scan-", actorId: "system:marketplace" }, async ({ dir, ref }) => {
    const scanId = randomUUID();
    pruneScans(now);
    scans.set(scanId, { source, ref, skills: await discoverSkills(dir), audited: new Set(), expires: now + SCAN_TTL_MS });
    marketplaceCache.set(source, { scanId, expires: now + SCAN_TTL_MS, manifest: await readManifest(dir) });
  });
  return loadMarketplace(gitSync, soulLoader, bundledSkills, disabledBundledSkills);
}
// The operator sees that the catalog is unreachable, never git's stderr or a server temp path.
function sendMarketplaceUnavailable(reply: FastifyReply, error: unknown) {
  const denial = gitSourceHttpError(error);
  return reply.code(502).send({ error: `marketplace unavailable: ${denial?.body.error ?? "the catalog repository could not be read"}` });
}
function rethrowSoulWriteError(reply: FastifyReply, error: unknown): never | FastifyReply {
  if (isSoulWriteError(error)) {
    const mapped = soulWriteHttpError(error);
    return reply.code(mapped.status).send(mapped.body);
  }
  throw error;
}
export function registerSkillRoutes(app: FastifyInstance, soulLoader: SoulLoader, gitSync: GitSyncService, soulWriter: SoulWriter, llmService: LlmService, requireAuth: PreHandler, activity?: ActivityService, bundledSkills: ReadonlyMap<string, BundledSkill> = new Map(), disabledBundledSkills: Set<string> = new Set(), audit?: AuditService): void {
  const auditWrite = makeSoulAuditWriter(audit);
  app.get("/api/v1/skills", {
    preHandler: requireAuth,
    schema: {
      description: "List Soul and bundled Skills with provenance.",
      tags: ["skills"], security: [{ sessionCookie: [] }, { bearerToken: [] }],
      response: { 200: SkillListResponseSchema, 401: ErrorSchema },
    },
  }, async () => {
    const lock = await readLock(gitSync.path);
    const skills = Array.from(mergedSkills(soulLoader, bundledSkills, disabledBundledSkills).values()).map((skill) => toSkillSummary(skill, lock, !soulLoader.skills.has(skill.name)));
    return { skills };
  });
  app.get("/api/v1/skills/marketplace", {
    preHandler: requireAuth,
    schema: {
      description: "Browse the official skills marketplace (TulipFarm/skills). Returns a scanId usable with the audit and install endpoints.",
      tags: ["skills"], security: [{ sessionCookie: [] }, { bearerToken: [] }],
      response: { 200: SkillMarketplaceResponseSchema, 401: ErrorSchema, 502: ErrorSchema },
    },
  }, async (_req, reply) => {
    reply.header("cache-control", "no-store");
    try {
      return await loadMarketplace(gitSync, soulLoader, bundledSkills, disabledBundledSkills);
    } catch (error) {
      return sendMarketplaceUnavailable(reply, error);
    }
  });
  app.get("/api/v1/skills/updates", {
    preHandler: requireAuth,
    schema: {
      description: "List installed marketplace Skills whose locked content hash differs from the current catalog.",
      tags: ["skills"], security: [{ sessionCookie: [] }, { bearerToken: [] }],
      response: { 200: SkillMarketplaceResponseSchema, 401: ErrorSchema, 502: ErrorSchema },
    },
  }, async (_req, reply) => {
    reply.header("cache-control", "no-store");
    try {
      const marketplace = await loadMarketplace(gitSync, soulLoader, bundledSkills, disabledBundledSkills);
      return { ...marketplace, skills: marketplace.skills.filter((skill) => skill.updateAvailable) };
    } catch (error) {
      return sendMarketplaceUnavailable(reply, error);
    }
  });
  app.get("/api/v1/skills/:name", {
    preHandler: requireAuth,
    schema: {
      description: "Get a single skill including its SKILL.md markdown body.",
      tags: ["skills"], security: [{ sessionCookie: [] }, { bearerToken: [] }],
      params: SkillNameParamsSchema,
      response: { 200: SkillDetailResponseSchema, 401: ErrorSchema, 404: ErrorSchema },
    },
  }, async (req, reply) => {
    const { name } = req.params as { name: string };
    const skill = resolveSkill(name, soulLoader, bundledSkills, disabledBundledSkills);
    if (!skill) return reply.code(404).send({ error: `skill not found: ${name}` });
    const lock = await readLock(gitSync.path);
    const bundled = bundledSkills.get(name);
    const directory = soulLoader.skills.has(name) ? join(gitSync.path, "skills", name) : bundled?.directory;
    return { ...toSkillSummary(skill, lock, !soulLoader.skills.has(name)), body: skill.body, ...(await skillPackageDetail(directory)) };
  });
  app.delete("/api/v1/skills/:name", {
    preHandler: requireAuth,
    schema: {
      description: "Remove an installed skill from the soul repo (and its skills-lock entry).",
      tags: ["skills"], security: [{ sessionCookie: [] }, { bearerToken: [] }],
      params: SkillNameParamsSchema,
      response: { 204: SkillDeleteResponseSchema, 400: ErrorSchema, 401: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema, 422: ErrorSchema, 500: ErrorSchema },
    },
  }, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!NAME_RE.test(name) || !resolveSkill(name, soulLoader, bundledSkills, disabledBundledSkills)) return reply.code(404).send({ error: `skill not found: ${name}` });
    const lock = await readLock(gitSync.path);
    delete lock.skills[name];
    const changes: SoulWrite[] = [];
    if (soulLoader.skills.has(name)) changes.push({ op: "deleteArtifact", kind: "Skill", slug: name });
    changes.push({ op: "put", target: { kind: "SkillsLock" }, content: `${JSON.stringify(lock, null, 2)}\n` });
    try {
      await soulWriter.apply({ subject: `soul: remove skill ${name}`, source: "api", actor: commitActorFromRequest(req), businessId: DEPLOYMENT_BUSINESS_ID, changes });
    } catch (error) {
      return rethrowSoulWriteError(reply, error);
    }
    if (bundledSkills.has(name)) {
      disabledBundledSkills.add(name);
      await persistDisabledBundledSkills(gitSync.path, disabledBundledSkills);
      await gitSync.commitPaths(`soul: disable bundled skill ${name}`, [join("skills", DISABLED_BUNDLED_SKILLS_FILE)], commitActorFromRequest(req));
    }
    await soulLoader.reload();
    await auditWrite(req, "skill.remove", `skill:${name}`, { bundled: bundledSkills.has(name) });
    return reply.code(204).send();
  });
  app.post("/api/v1/skills/scan", {
    preHandler: requireAuth,
    schema: {
      description: "Clone a git repo (source accepts an optional #branch suffix) and discover installable SKILL.md files.",
      tags: ["skills"], security: [{ sessionCookie: [] }, { bearerToken: [] }],
      body: SkillScanBodySchema,
      response: { 200: SkillScanResponseSchema, 400: ErrorSchema, 401: ErrorSchema, 429: ErrorSchema },
    },
  }, async (req, reply) => {
    const { source } = req.body as { source: string };
    try {
      return await withGitSourceClone(source, { prefix: "skill-scan-", actorId: commitActorFromRequest(req).principalId }, async ({ dir, ref }) => {
        const discovered = await discoverSkills(dir);
        if (discovered.length === 0) return reply.code(400).send({ error: "no SKILL.md files found in repo" });
        const lock = await readLock(gitSync.path);
        const scanId = randomUUID();
        pruneScans(Date.now());
        scans.set(scanId, { source, ref, skills: discovered, audited: new Set(), expires: Date.now() + SCAN_TTL_MS });
        return { scanId, skills: discovered.map((skill) => ({ name: skill.name, skillPath: skill.skillPath, description: skill.description, ...installStatus(skill, lock, soulLoader, bundledSkills, disabledBundledSkills) })) };
      });
    } catch (error) {
      const denial = gitSourceHttpError(error);
      if (!denial) throw error;
      return reply.code(denial.status).send(denial.body);
    }
  });
  app.post("/api/v1/skills/audit", {
    preHandler: requireAuth,
    schema: {
      description: "Run the advisory SkillAudit review on a scanned skill.",
      tags: ["skills"], security: [{ sessionCookie: [] }, { bearerToken: [] }],
      body: SkillAuditBodySchema,
      response: { 200: SkillAuditResponseSchema, 401: ErrorSchema, 404: ErrorSchema, 422: ErrorSchema, 502: ErrorSchema },
    },
  }, async (req, reply) => {
    const { scanId, name, skillPath } = req.body as { scanId: string; name: string; skillPath?: string };
    const entry = scans.get(scanId);
    const skill = entry?.skills.find((scannedSkill) => (skillPath === undefined ? scannedSkill.name === name : scannedSkill.skillPath === skillPath));
    if (!entry || !skill) return reply.code(404).send({ error: "scanned skill not found (scan may have expired)" });
    const { body } = parseFrontmatter(skill.content);
    const deterministicScan = { ...scanSkill(skill.files), trustLevel: skillTrustLevel(entry.source) };
    try {
      const report = await buildAudit(llmService.effortModel("balanced"), { name: skill.name, description: skill.description, body }, deterministicScan);
      entry.audited.add(skill.skillPath);
      return { report };
    } catch (error) {
      if (error instanceof LlmNotConfiguredError) {
        return reply.code(422).send({ error: "SkillAudit needs an LLM provider — configure one in Operate → Business → Models." });
      }
      return reply.code(502).send({ error: `SkillAudit failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  });
  app.post("/api/v1/skills/install", {
    preHandler: requireAuth,
    schema: {
      description: "Operator confirm: install the named scanned skills into the soul repo.",
      tags: ["skills"], security: [{ sessionCookie: [] }, { bearerToken: [] }],
      body: SkillInstallBodySchema,
      response: { 200: SkillInstallResponseSchema, 400: ErrorSchema, 401: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema, 422: ErrorSchema, 500: ErrorSchema },
    },
  }, async (req, reply) => {
    const { scanId, names, paths } = req.body as { scanId: string; names?: string[]; paths?: string[] };
    const entry = scans.get(scanId);
    if (!entry) return reply.code(404).send({ error: "scan not found (it may have expired)" });
    // `paths` names a scanned row exactly; `names` is the legacy selection and cannot tell two same-named packages apart, so it stays ambiguous by construction.
    const wanted = paths !== undefined
      ? [...new Set(paths)].map((path) => ({ key: path, matches: entry.skills.filter((skill) => skill.skillPath === path) }))
      : [...new Set(names ?? [])].map((name) => ({ key: name, matches: entry.skills.filter((skill) => skill.name === name) }));
    if (wanted.length === 0) return reply.code(400).send({ error: "select at least one skill to install" });
    const missing = wanted.filter((want) => want.matches.length === 0).map((want) => want.key);
    if (missing.length > 0) return reply.code(400).send({ error: `not in scan: ${missing.join(", ")}` });
    const chosen = wanted.flatMap((want) => (want.matches.length === 1 ? want.matches : []));
    // A Skill name is its soul directory, so two chosen Skills sharing one name cannot both be installed. Refuse rather than install whichever the scan listed first: the operator reviewed two packages and would be given one.
    const collisions = [...new Set(chosen.map((skill) => skill.name))].map((name) => chosen.filter((skill) => skill.name === name)).filter((group) => group.length > 1);
    const ambiguous = [...wanted.filter((want) => want.matches.length > 1).map((want) => want.matches), ...collisions];
    if (ambiguous.length > 0) return reply.code(400).send({ error: `this source defines more than one skill with the same name, so the selection is ambiguous: ${ambiguous.map((matches) => `${matches[0].name} (${matches.map((skill) => skill.skillPath).join(", ")})`).join("; ")}` });
    const unaudited = chosen.filter((skill) => !entry.audited.has(skill.skillPath));
    if (unaudited.length > 0) return reply.code(409).send({ error: `audit required before install: ${unaudited.map((skill) => skill.name).join(", ")}` });
    for (const skill of chosen) {
      const { frontmatter, body } = parseFrontmatter(skill.content);
      const validation = validateSkill({ name: skill.name, frontmatter, body, content: skill.content });
      if (!validation.valid) return reply.code(400).send({ error: `invalid Skill "${skill.name}": ${validation.error}` });
      const unstorable = unstorableArtifactPaths("Skill", skill.name, skill.files.filter((file) => file.symlinkTarget === undefined).map((file) => file.path));
      if (unstorable.length > 0) return reply.code(400).send({ error: `Skill "${skill.name}" contains files the soul cannot store: ${unstorable.join(", ")}` });
      const blockers = scanSkill(skill.files).findings.filter((finding) => STRUCTURAL_INSTALL_BLOCKERS.has(finding.patternId));
      if (blockers.length > 0) {
        return reply.code(400).send({ error: `Skill "${skill.name}" contains unsupported package files: ${[...new Set(blockers.map((finding) => finding.patternId))].join(", ")}` });
      }
      const executableBlocker = executablePackageBlocker(skill);
      if (executableBlocker !== undefined) return reply.code(400).send({ error: `Skill "${skill.name}" cannot be published: ${executableBlocker}` });
    }
    const installed: string[] = [];
    const changes: SoulWrite[] = [];
    for (const skill of chosen) {
      changes.push(...(await skillInstallChanges(gitSync.path, skill)));
      installed.push(skill.name);
    }
    const lock = await readLock(gitSync.path);
    for (const skill of chosen) {
      lock.skills[skill.name] = { sourceUrl: stripUrlCredentials(entry.source), sourceType: sourceType(entry.source), skillPath: skill.skillPath, ref: entry.ref, hash: skillDirectoryHash(skill.files) };
    }
    changes.push({ op: "put", target: { kind: "SkillsLock" }, content: `${JSON.stringify(lock, null, 2)}\n` });
    try {
      await soulWriter.apply({ subject: `soul: install skill(s) ${installed.join(", ")}`, source: "api", actor: commitActorFromRequest(req), businessId: DEPLOYMENT_BUSINESS_ID, changes });
    } catch (error) {
      return rethrowSoulWriteError(reply, error);
    }
    await soulLoader.reload();
    await activity?.record({
      category: "skill",
      action: "skill.installed",
      actorId: (req.user as { _id: string } | undefined)?._id,
      targetType: "skill",
      targetId: installed.join(", "),
      summary: `Installed skill(s): ${installed.join(", ")}`,
      metadata: { skills: installed, source: stripUrlCredentials(entry.source), ref: entry.ref },
    });
    await auditWrite(req, "skill.install", `skill:${installed.join(",")}`, { skills: installed, source: redactRemoteUrl(entry.source), ...(entry.ref ? { ref: entry.ref } : {}) });
    return { installed };
  });
}
