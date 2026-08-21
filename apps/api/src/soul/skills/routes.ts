import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { gitSourceHttpError, withGitSourceClone } from "@tulipfarm/integrations";
import type { LlmService } from "@tulipfarm/llm";
import { SandboxRuntimeProfileRegistry, shellTsPythonV1 } from "@tulipfarm/sandbox";
import {
  DEFINITION_REGISTRATIONS,
  LlmNotConfiguredError,
  SchemaRegistry,
  type SkillDefinition,
} from "@tulipfarm/schema";
import {
  type BundledSkill,
  collectSkillFiles,
  createSkillMarketplaceFlow as createSoulSkillMarketplaceFlow,
  DISABLED_BUNDLED_SKILLS_FILE,
  type DiscoveredSkill,
  type GitSyncService,
  isSoulWriteError,
  mergedSkills,
  parseFrontmatter,
  persistDisabledBundledSkills,
  resolveSkill,
  SkillMarketplaceError,
  type SkillMarketplaceFlow,
  type SkillScanFile,
  type SoulLoader,
  type SoulSkill,
  type SoulWrite,
  type SoulWriter,
  soulWriteHttpError,
} from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ActivityService } from "../../activity/service";
import type { AuditService } from "../../audit/service";
import { makeSoulAuditWriter, redactRemoteUrl } from "../../audit/soul-write";
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
type LockEntry = {
  sourceUrl?: string;
  sourceType?: string;
  skillPath?: string;
  ref?: string;
  hash?: string;
};
type SkillsLock = { version: number; skills: Record<string, LockEntry> };
type SkillSummary = {
  name: string;
  description?: string;
  provenance: "builtin" | "marketplace" | "user";
  source?: string;
  pendingAudit: boolean;
};
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const definitionRegistry = new SchemaRegistry(DEFINITION_REGISTRATIONS);
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
          deps.llmService.effortModel("balanced"),
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
async function readLock(soulPath: string): Promise<SkillsLock> {
  try {
    const parsed = JSON.parse(
      await readFile(join(soulPath, "skills-lock.json"), "utf8")
    ) as SkillsLock;
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
      const lock = await readLock(gitSync.path);
      delete lock.skills[name];
      const changes: SoulWrite[] = [];
      if (soulLoader.skills.has(name))
        changes.push({ op: "deleteArtifact", kind: "Skill", slug: name });
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
