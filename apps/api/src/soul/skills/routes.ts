import { basename, join } from "node:path";
import { buildAudit, SKILL_AUDIT } from "@tulipfarm/built-in-agents";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { gitSourceHttpError, withGitSourceClone } from "@tulipfarm/integrations";
import type { LlmService } from "@tulipfarm/llm";
import { SandboxRuntimeProfileRegistry, shellTsPythonV1 } from "@tulipfarm/sandbox";
import { LlmNotConfiguredError, type SkillDefinition } from "@tulipfarm/schema";
import {
  type BundledSkill,
  collectSkillFiles,
  createSkillMarketplaceFlow as createSoulSkillMarketplaceFlow,
  DISABLED_BUNDLED_SKILLS_FILE,
  type DiscoveredSkill,
  type GitSyncService,
  isSoulWriteError,
  mergedSkills,
  mutateSkillsLock,
  parseFrontmatter,
  persistDisabledBundledSkills,
  readSkillsLock,
  resolveSkill,
  SkillMarketplaceError,
  type SkillMarketplaceFlow,
  type SkillScanFile,
  type SkillSourceType,
  type SkillsLock,
  type SoulLoader,
  type SoulSkill,
  type SoulWrite,
  type SoulWriter,
  serializeSkillsLock,
  skillDocumentFromMarkdown,
  soulWriteHttpError,
} from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ActivityService } from "../../activity/service";
import type { AuditService } from "../../audit/service";
import { makeSoulAuditWriter, redactRemoteUrl } from "../../audit/soul-write";
import { ErrorSchema } from "../../auth/schemas";
import { commitActorFromRequest } from "../commit-actor";
import {
  SkillAuditBodySchema,
  SkillAuditResponseSchema,
  SkillDeleteResponseSchema,
  SkillDetailResponseSchema,
  SkillFileQuerySchema,
  SkillFileResponseSchema,
  SkillInstallBodySchema,
  SkillInstallResponseSchema,
  SkillListResponseSchema,
  SkillMarketplaceResponseSchema,
  SkillNameParamsSchema,
  SkillScanBodySchema,
  SkillScanResponseSchema,
} from "./schemas";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
type SkillPackageDetail = {
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
};
type SkillSummary = {
  name: string;
  description?: string;
  /** Where the Skill came from, read straight from `skills-lock.json`. */
  provenance: SkillSourceType;
  /** The Skill's own version, as declared in its `SKILL.md`. */
  version?: string;
  source?: string;
  category?: string;
  author?: string;
  updatedAt?: string;
  tools?: string[];
  allowedDomains?: string[];
  allowedCommands?: string[];
  requiredSecrets?: string[];
};
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
/**
 * A frontmatter list, normalised.
 *
 * Frontmatter is author input validated with `additionalProperties: true`, so a key like `tools`
 * reaches here as whatever YAML parsed — a string, a map, a list with a number in it. Anything that
 * is not a non-empty string is dropped rather than coerced, so the UI never renders `[object
 * Object]` as a Tool the Skill can call.
 */
function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return items.length > 0 ? items : undefined;
}
function runtimeStatus(
  runtimeProfile: string,
  requiredCommands: readonly string[]
): { runtimeAvailable: boolean; blocker?: string } {
  if (process.env.NODE_ENV === "production")
    return {
      runtimeAvailable: false,
      blocker: "an attested production sandbox backend is not configured",
    };
  const configuredImage = process.env.SANDBOX_RUNTIME_IMAGE;
  const digest =
    process.env.SANDBOX_RUNTIME_IMAGE_DIGEST ??
    configuredImage?.match(/@(sha256:[0-9a-f]{64})$/)?.[1];
  if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest))
    return { runtimeAvailable: false, blocker: "sandbox runtime image digest is not configured" };
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
/**
 * Commands a Skill package declares, projected from its `SKILL.md` frontmatter.
 *
 * `invalid` distinguishes "declares no commands" from "declares commands the canonical Skill schema
 * rejects"; the projection collapses both to no document, and only the second is an operator fault.
 */
function packageCommands(
  slug: string,
  files: readonly SkillScanFile[]
): { commands: SkillDefinition["spec"]["commands"]; invalid: boolean } {
  const markdown = files.find((file) => file.path === "SKILL.md");
  if (markdown === undefined) return { commands: undefined, invalid: false };
  const document = skillDocumentFromMarkdown(slug, markdown.content, "SKILL.md");
  if (document === undefined) {
    return {
      commands: undefined,
      invalid: parseFrontmatter(markdown.content).frontmatter.commands !== undefined,
    };
  }
  return { commands: (document as unknown as SkillDefinition).spec.commands, invalid: false };
}

async function skillPackageDetail(directory: string | undefined): Promise<SkillPackageDetail> {
  if (directory === undefined) return { files: [], commands: [] };
  let files: SkillScanFile[];
  try {
    files = await collectSkillFiles(directory);
  } catch {
    return { files: [], commands: [] };
  }
  return {
    files: files.map((file) => ({ path: file.path, size: file.size ?? 0 })),
    commands: (packageCommands(basename(directory), files).commands ?? []).map((command) => ({
      name: command.name,
      toolRef: command.toolRef,
      runtimeProfile: command.runtimeProfile,
      entrypoint: command.entrypoint,
      requiredCommands: command.requiredCommands ?? [],
      ...runtimeStatus(command.runtimeProfile, command.requiredCommands ?? []),
    })),
  };
}
/** Beyond this a reference stops being something anyone reads in a browser panel. */
const MAX_SKILL_FILE_CHARS = 200_000;

/**
 * One file out of a Skill package, or `undefined` when the package does not contain it.
 *
 * The path is resolved by matching what {@link collectSkillFiles} already listed rather than by
 * joining it onto the directory. That walker refuses to leave the package root and flags a symlink
 * that resolves outside it, so reusing its output as the allowlist means no caller-supplied string
 * ever reaches the filesystem and there is no traversal check here to get wrong.
 */
async function readSkillPackageFile(
  directory: string,
  requested: string
): Promise<
  { path: string; size: number; content: string; truncated: boolean; binary: boolean } | undefined
> {
  let files: SkillScanFile[];
  try {
    files = await collectSkillFiles(directory);
  } catch {
    return undefined;
  }
  const file = files.find((candidate) => candidate.path === requested);
  if (!file || file.symlinkEscapes) return undefined;
  // `collectSkillFiles` decodes every file as UTF-8, so a binary asset arrives as replacement
  // characters. Reporting that as text would render a screenful of garbage as if it were content.
  const binary = file.content.includes("\u0000") || /\uFFFD{4,}/.test(file.content);
  const truncated = !binary && file.content.length > MAX_SKILL_FILE_CHARS;
  return {
    path: file.path,
    size: file.size ?? Buffer.byteLength(file.content),
    content: binary ? "" : truncated ? file.content.slice(0, MAX_SKILL_FILE_CHARS) : file.content,
    truncated,
    binary,
  };
}

function executablePackageBlocker(skill: DiscoveredSkill): string | undefined {
  const { commands, invalid } = packageCommands(skill.name, skill.files);
  if (invalid) return "SKILL.md declares commands but is not a valid Skill definition";
  const paths = new Set(skill.files.map((file) => file.path));
  for (const command of commands ?? []) {
    if (!paths.has(command.entrypoint))
      return `command ${command.name} entrypoint is not present in the Skill package`;
    const status = runtimeStatus(command.runtimeProfile, command.requiredCommands ?? []);
    if (!status.runtimeAvailable)
      return `command ${command.name}: ${status.blocker ?? "sandbox runtime is unavailable"}`;
    if ((command.integrationBindings?.length ?? 0) > 1)
      return `command ${command.name} declares more than one Integration credential`;
  }
  return undefined;
}

export function createSkillMarketplaceFlow(deps: {
  gitSync: GitSyncService;
  soulLoader: SoulLoader;
  soulWriter: SoulWriter;
  llmService: LlmService;
  bundledSkills: ReadonlyMap<string, BundledSkill>;
  disabledBundledSkills: ReadonlySet<string>;
}): SkillMarketplaceFlow {
  return createSoulSkillMarketplaceFlow({
    ...deps,
    cloneSource: withGitSourceClone,
    executablePackageBlocker,
    audit: async (skill, deterministicScan) => {
      try {
        return await buildAudit(
          deps.llmService.effortModel(SKILL_AUDIT.rung),
          {
            name: skill.name,
            description: skill.description,
            body: parseFrontmatter(skill.content).body,
          },
          deterministicScan
        );
      } catch (error) {
        if (error instanceof LlmNotConfiguredError) {
          throw new SkillMarketplaceError(
            422,
            "SkillAudit needs an LLM provider — configure one in Operate → Business → Models."
          );
        }
        throw error;
      }
    },
  });
}
function toSkillSummary(
  skill: SoulSkill,
  lock: SkillsLock,
  bundledOnly = false,
  updatedAt?: string
): SkillSummary {
  const locked = lock.skills[skill.name];
  // A Skill only in the image has no Soul entry yet; the boot sync has not run or it is disabled.
  const provenance: SkillSourceType = bundledOnly ? "bundled" : (locked?.sourceType ?? "curated");
  const frontmatter = skill.frontmatter;
  return {
    name: skill.name,
    description: asString(frontmatter.description),
    provenance,
    version: locked?.version ?? asString(frontmatter.version),
    source: provenance === "bundled" ? undefined : locked?.sourceUrl,
    category: asString(frontmatter.category),
    author: asString(frontmatter.author),
    updatedAt,
    tools: asStringList(frontmatter.tools),
    allowedDomains: asStringList(frontmatter.allowedDomains),
    allowedCommands: asStringList(frontmatter.allowedCommands),
    requiredSecrets: asStringList(frontmatter.requiredSecrets),
  };
}
// The operator sees that the catalog is unreachable, never git's stderr or a server temp path.
function sendMarketplaceUnavailable(reply: FastifyReply, error: unknown) {
  const denial = gitSourceHttpError(error);
  return reply.code(502).send({
    error: `marketplace unavailable: ${denial?.body.error ?? "the catalog repository could not be read"}`,
  });
}
function rethrowSoulWriteError(reply: FastifyReply, error: unknown): never | FastifyReply {
  if (isSoulWriteError(error)) {
    const mapped = soulWriteHttpError(error);
    return reply.code(mapped.status).send(mapped.body);
  }
  throw error;
}
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
  audit?: AuditService,
  marketplace: SkillMarketplaceFlow = createSkillMarketplaceFlow({
    gitSync,
    soulLoader,
    soulWriter,
    llmService,
    bundledSkills,
    disabledBundledSkills,
  })
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
        response: { 200: SkillListResponseSchema, 401: ErrorSchema },
      },
    },
    async () => {
      const lock = await readSkillsLock(gitSync.path);
      const merged = Array.from(
        mergedSkills(soulLoader, bundledSkills, disabledBundledSkills).values()
      );
      const paths = merged
        .filter((skill) => soulLoader.skills.has(skill.name))
        .map((skill) => `skills/${skill.name}/SKILL.md`);
      const updatedAt = await gitSync.lastCommitDates(paths);
      const skills = merged.map((skill) => {
        const inSoul = soulLoader.skills.has(skill.name);
        return toSkillSummary(
          skill,
          lock,
          !inSoul,
          inSoul ? updatedAt.get(`skills/${skill.name}/SKILL.md`) : undefined
        );
      });
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
        response: { 200: SkillMarketplaceResponseSchema, 401: ErrorSchema, 502: ErrorSchema },
      },
    },
    async (_req, reply) => {
      reply.header("cache-control", "no-store");
      try {
        return await marketplace.browse();
      } catch (error) {
        return sendMarketplaceUnavailable(reply, error);
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
        response: { 200: SkillMarketplaceResponseSchema, 401: ErrorSchema, 502: ErrorSchema },
      },
    },
    async (_req, reply) => {
      reply.header("cache-control", "no-store");
      try {
        const catalog = await marketplace.browse();
        return { ...catalog, skills: catalog.skills.filter((skill) => skill.updateAvailable) };
      } catch (error) {
        return sendMarketplaceUnavailable(reply, error);
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
        params: SkillNameParamsSchema,
        response: { 200: SkillDetailResponseSchema, 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      const skill = resolveSkill(name, soulLoader, bundledSkills, disabledBundledSkills);
      if (!skill) return reply.code(404).send({ error: `skill not found: ${name}` });
      const lock = await readSkillsLock(gitSync.path);
      const bundled = bundledSkills.get(name);
      const directory = soulLoader.skills.has(name)
        ? join(gitSync.path, "skills", name)
        : bundled?.directory;
      return {
        ...toSkillSummary(skill, lock, !soulLoader.skills.has(name)),
        license: asString(skill.frontmatter.license),
        body: skill.body,
        ...(await skillPackageDetail(directory)),
      };
    }
  );
  app.get(
    "/api/v1/skills/:name/file",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Read one file from an installed Skill's package, so references and scripts can be inspected before the Skill is trusted.",
        tags: ["skills"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: SkillNameParamsSchema,
        querystring: SkillFileQuerySchema,
        response: { 200: SkillFileResponseSchema, 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      const { path: requested } = req.query as { path: string };
      if (!NAME_RE.test(name)) return reply.code(404).send({ error: `skill not found: ${name}` });
      const skill = resolveSkill(name, soulLoader, bundledSkills, disabledBundledSkills);
      if (!skill) return reply.code(404).send({ error: `skill not found: ${name}` });
      const directory = soulLoader.skills.has(name)
        ? join(gitSync.path, "skills", name)
        : bundledSkills.get(name)?.directory;
      if (directory === undefined)
        return reply.code(404).send({ error: `skill not found: ${name}` });
      const file = await readSkillPackageFile(directory, requested);
      if (!file) return reply.code(404).send({ error: `file not found: ${requested}` });
      return file;
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
        params: SkillNameParamsSchema,
        response: {
          204: SkillDeleteResponseSchema,
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
      )
        return reply.code(404).send({ error: `skill not found: ${name}` });
      try {
        await mutateSkillsLock(soulWriter, gitSync.path, (lock) => {
          delete lock.skills[name];
          const changes: SoulWrite[] = [];
          if (soulLoader.skills.has(name))
            changes.push({ op: "deleteArtifact", kind: "Skill", slug: name });
          changes.push({
            op: "put",
            target: { kind: "SkillsLock" },
            content: serializeSkillsLock(lock),
          });
          return {
            subject: `soul: remove skill ${name}`,
            source: "api",
            actor: commitActorFromRequest(req),
            businessId: DEPLOYMENT_BUSINESS_ID,
            changes,
          };
        });
      } catch (error) {
        return rethrowSoulWriteError(reply, error);
      }
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
      await auditWrite(req, "skill.remove", `skill:${name}`, { bundled: bundledSkills.has(name) });
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
        body: SkillScanBodySchema,
        response: {
          200: SkillScanResponseSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          429: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { source } = req.body as { source: string };
      try {
        return await marketplace.scan({ source, actorId: commitActorFromRequest(req).principalId });
      } catch (error) {
        if (error instanceof SkillMarketplaceError && error.status === 400) {
          return reply.code(400).send({ error: error.message });
        }
        const denial = gitSourceHttpError(error);
        if (!denial) throw error;
        return reply.code(denial.status).send(denial.body);
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
        body: SkillAuditBodySchema,
        response: {
          200: SkillAuditResponseSchema,
          401: ErrorSchema,
          404: ErrorSchema,
          422: ErrorSchema,
          502: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { scanId, name, skillPath } = req.body as {
        scanId: string;
        name: string;
        skillPath: string;
      };
      try {
        return await marketplace.audit({ scanId, name, skillPath });
      } catch (error) {
        if (
          error instanceof SkillMarketplaceError &&
          (error.status === 404 || error.status === 422)
        ) {
          return reply.code(error.status).send({ error: error.message });
        }
        return reply.code(502).send({
          error: `SkillAudit failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
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
        body: SkillInstallBodySchema,
        response: {
          200: SkillInstallResponseSchema,
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
      const { scanId, names, paths } = req.body as {
        scanId: string;
        names?: string[];
        paths?: string[];
      };
      try {
        const result = await marketplace.install({
          scanId,
          names,
          paths,
          actor: commitActorFromRequest(req),
          source: "api",
        });
        const installed = result.installed.map((skill) => skill.name);
        await activity?.record({
          category: "skill",
          action: "skill.installed",
          actorId: (req.user as { _id: string } | undefined)?._id,
          targetType: "skill",
          targetId: installed.join(", "),
          summary: `Installed skill(s): ${installed.join(", ")}`,
          metadata: { skills: installed, source: result.source, ref: result.ref },
        });
        await auditWrite(req, "skill.install", `skill:${installed.join(",")}`, {
          skills: installed,
          source: redactRemoteUrl(result.source),
          ...(result.ref ? { ref: result.ref } : {}),
        });
        return { installed };
      } catch (error) {
        if (error instanceof SkillMarketplaceError)
          return reply.code(error.status).send({ error: error.message });
        return rethrowSoulWriteError(reply, error);
      }
    }
  );
}
