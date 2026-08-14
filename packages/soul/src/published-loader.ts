import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  DEFINITION_REGISTRATIONS,
  parseFrontmatter,
  type ResourceDefinition,
  type RoleDefinition,
  SchemaRegistry,
  TulipFarmValidationError,
  validateLegacyIntegrationManifest,
  validateResourceSchema,
  validateSoulConfig,
} from "@tulipfarm/schema";
import {
  type SoulSurfaceComponent,
  type SurfaceComponentSupport,
  validateSoulSurfaceCatalog,
  validateSoulSurfaceComponent,
} from "@tulipfarm/surface";
import { parse as parseYaml } from "yaml";
import { readFrontmatterArtifact, resolveDefinition } from "./definition-reader";
import { validateAuthSteps, validateIngressContextEnv } from "./integration-auth";
import { readContainedFile } from "./safe-fs";
import type {
  IntegrationConnection,
  IntegrationManifest,
  Logger,
  SoulAgent,
  SoulIntegration,
  SoulResource,
  SoulRole,
  SoulRoutine,
  SoulSkill,
} from "./types";

/** Re-export kept for package API; schema owns legacy frontmatter parsing. */
export { parseFrontmatter };

const definitionRegistry = new SchemaRegistry(DEFINITION_REGISTRATIONS);

async function subdirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    const isNotFound =
      err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
    if (isNotFound) return [];
    throw err;
  }
}

async function fileExists(rootPath: string, path: string): Promise<boolean> {
  try {
    await readContainedFile(rootPath, path);
    return true;
  } catch (err) {
    const isNotFound =
      err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
    if (isNotFound) return false;
    throw err;
  }
}

function artifactLoadError(kind: string, name: string, err: unknown): Error {
  const detail = err instanceof Error ? err.message : String(err);
  return new Error(`Soul: failed to load published ${kind} "${name}": ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Canonical Resource envelopes must validate; otherwise legacy fallback would drop `spec.domain`. */
function resourceDefinitionOf(content: string, path: string): ResourceDefinition {
  const validated = definitionRegistry.validateYaml(content);
  if (validated.kind !== "Resource") {
    throw new Error(`${path}: expected a Resource definition but found kind "${validated.kind}"`);
  }
  return validated.document as unknown as ResourceDefinition;
}

/** Load declared OpenAPI specs here; unreadable specs are fatal so Tools do not vanish silently. */
async function loadEgressSpec(dir: string, manifest: IntegrationManifest): Promise<unknown> {
  if (manifest.egress?.type !== "openapi") return undefined;
  const specFile = basename(manifest.egress.spec);
  try {
    // JSON is valid YAML, so one parser covers both the .json and .yaml specs providers publish.
    return parseYaml(await readContainedFile(dir, join(dir, specFile)));
  } catch (err) {
    throw new Error(
      `declares egress.spec "${specFile}" but it could not be loaded: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

export class SoulLoader {
  agents: Map<string, SoulAgent> = new Map();
  skills: Map<string, SoulSkill> = new Map();
  resources: Map<string, SoulResource> = new Map();
  routines: Map<string, SoulRoutine> = new Map();
  roles: Map<string, SoulRole> = new Map();
  integrations: Map<string, SoulIntegration> = new Map();
  surfaceComponents: Map<string, SoulSurfaceComponent> = new Map();
  llmConfig: Record<string, unknown> | null = null;
  guardrailsConfig: Record<string, unknown> | null = null;
  observabilityConfig: Record<string, unknown> | null = null;
  manifest: Record<string, unknown> | null = null;
  /** Skipped artifacts and reasons; missing definitions quarantine instead of breaking the catalog. */
  quarantined: Array<{ kind: string; name: string; reason: string }> = [];

  constructor(
    private readonly soulPath: string,
    private readonly logger: Logger,
    private readonly surfaceSupport?: SurfaceComponentSupport
  ) {}

  async load(): Promise<void> {
    this.quarantined = [];
    const [
      agents,
      skills,
      resources,
      routines,
      roles,
      integrations,
      surfaceComponents,
      guardrailsConfig,
      observabilityConfig,
      manifest,
    ] = await Promise.all([
      this.loadAgents(),
      this.loadSkills(),
      this.loadResources(),
      this.loadRoutines(),
      this.loadRoles(),
      this.loadIntegrations(),
      this.loadSurfaceComponents(),
      this.loadYamlFile(join(this.soulPath, "guardrails.yaml"), "guardrails.yaml"),
      this.loadYamlFile(
        join(this.soulPath, "observability.config.yaml"),
        "observability.config.yaml"
      ),
      this.loadYamlFile(join(this.soulPath, "soul.yaml"), "soul.yaml"),
    ]);

    this.agents = agents;
    this.skills = skills;
    this.resources = resources;
    this.routines = routines;
    this.roles = roles;
    this.integrations = integrations;
    this.surfaceComponents = surfaceComponents;
    this.llmConfig = (manifest?.llm as Record<string, unknown> | undefined) ?? null;
    this.guardrailsConfig = guardrailsConfig;
    this.observabilityConfig = observabilityConfig;
    this.manifest = manifest;

    this.logger.info(
      `Soul: loaded ${agents.size} agent(s), ${skills.size} skill(s), ${resources.size} resource(s), ${routines.size} routine(s), ${roles.size} role(s), ${integrations.size} integration(s), ${surfaceComponents.size} Surface component(s)`
    );
    for (const entry of this.quarantined) {
      this.logger.warn(`Soul: skipped ${entry.kind} "${entry.name}" — ${entry.reason}`);
    }
  }

  private quarantine(kind: string, name: string, reason: string): void {
    this.quarantined.push({ kind, name, reason });
  }

  async reload(): Promise<void> {
    const prevResources = this.resources;
    await this.load();
    for (const [name, resource] of this.resources) {
      const prev = prevResources.get(name);
      if (prev?.hookHash && !resource.hookHash) {
        this.logger.warn(`[soul] hook integrity: hook removed for resource "${name}"`);
      } else if (prev?.hookHash && resource.hookHash && prev.hookHash !== resource.hookHash) {
        this.logger.warn(`[soul] hook integrity: hash changed for resource "${name}"`);
      }
    }
  }

  private async loadAgents(): Promise<Map<string, SoulAgent>> {
    const map = new Map<string, SoulAgent>();
    const names = await subdirs(join(this.soulPath, "agents"));
    for (const name of names) {
      try {
        const definition = await resolveDefinition(this.soulPath, "Agent", name);
        if (definition === undefined) {
          this.quarantine("agent", name, "no agent.yaml or AGENT.md in the directory");
          continue;
        }
        const { frontmatter, body } = await readFrontmatterArtifact(
          this.soulPath,
          "Agent",
          name,
          definition
        );
        map.set(name, { name, frontmatter, body });
      } catch (err) {
        throw artifactLoadError("agent", name, err);
      }
    }
    return map;
  }

  private async loadSkills(): Promise<Map<string, SoulSkill>> {
    const map = new Map<string, SoulSkill>();
    const names = await subdirs(join(this.soulPath, "skills"));
    for (const name of names) {
      try {
        const definition = await resolveDefinition(this.soulPath, "Skill", name);
        if (definition === undefined) {
          this.quarantine("skill", name, "no skill.yaml or SKILL.md in the directory");
          continue;
        }
        const { frontmatter, body } = await readFrontmatterArtifact(
          this.soulPath,
          "Skill",
          name,
          definition
        );
        map.set(name, { name, frontmatter, body });
      } catch (err) {
        throw artifactLoadError("skill", name, err);
      }
    }
    return map;
  }

  private async loadResources(): Promise<Map<string, SoulResource>> {
    const map = new Map<string, SoulResource>();
    const names = await subdirs(join(this.soulPath, "resources"));
    for (const name of names) {
      try {
        const definition = await resolveDefinition(this.soulPath, "Resource", name);
        if (definition === undefined) {
          this.quarantine("resource", name, "no resource.yaml or schema.yml in the directory");
          continue;
        }
        const resourceDefinition = definition.legacy
          ? undefined
          : resourceDefinitionOf(definition.content, definition.path);
        // The fallback is only ever the legacy pre-envelope `schema.yml`, where the file itself is
        // the Record schema. A non-legacy `resource.yaml` has already thrown above if invalid.
        const parsedSchema =
          resourceDefinition?.spec.recordSchema ??
          ((parseYaml(definition.content) ?? {}) as Record<string, unknown>);
        if (!isRecord(parsedSchema)) {
          throw new Error(`${definition.path}: expected a resource schema mapping`);
        }
        const schema: Record<string, unknown> = parsedSchema;
        validateResourceSchema(schema);
        const hooksPath = join(this.soulPath, "resources", name, "hooks.ts");
        const hasHooks = await fileExists(this.soulPath, hooksPath);
        const hookSource = hasHooks ? await readContainedFile(this.soulPath, hooksPath) : undefined;
        const hookHash = hookSource
          ? createHash("sha256").update(hookSource).digest("hex")
          : undefined;
        const hooksEnabled =
          resourceDefinition?.spec.hooks?.enabled ?? schema["x-hooks-enabled"] !== false;
        map.set(name, {
          name,
          ...(resourceDefinition?.spec.domain === undefined
            ? {}
            : { domain: resourceDefinition.spec.domain }),
          schema,
          hasHooks,
          hookSource,
          hookHash,
          hooksEnabled,
        });
      } catch (err) {
        throw artifactLoadError("resource", name, err);
      }
    }
    return map;
  }

  private async loadRoutines(): Promise<Map<string, SoulRoutine>> {
    const map = new Map<string, SoulRoutine>();
    const names = await subdirs(join(this.soulPath, "routines"));
    for (const name of names) {
      const configPath = join(this.soulPath, "routines", name, "routine.yaml");
      try {
        const content = await readContainedFile(this.soulPath, configPath);
        const config = (parseYaml(content) ?? {}) as Record<string, unknown>;
        const hooksPath = join(this.soulPath, "routines", name, "hooks.ts");
        const hasHooks = await fileExists(this.soulPath, hooksPath);
        const hookSource = hasHooks ? await readContainedFile(this.soulPath, hooksPath) : undefined;
        const hookHash = hookSource
          ? createHash("sha256").update(hookSource).digest("hex")
          : undefined;
        map.set(name, { name, config, hasHooks, hookSource, hookHash });
      } catch (err) {
        throw artifactLoadError("routine", name, err);
      }
    }
    return map;
  }

  private async loadRoles(): Promise<Map<string, SoulRole>> {
    const map = new Map<string, SoulRole>();
    const names = await subdirs(join(this.soulPath, "roles"));
    for (const name of names) {
      try {
        const definition = await resolveDefinition(this.soulPath, "Role", name);
        if (definition === undefined) {
          this.quarantine("role", name, "no role.yaml in the directory");
          continue;
        }
        const validated = definitionRegistry.validateYaml(definition.content);
        if (validated.kind !== "Role") {
          throw new Error(`${definition.path}: expected a Role definition`);
        }
        map.set(name, { name, definition: validated.document as RoleDefinition });
      } catch (err) {
        throw artifactLoadError("role", name, err);
      }
    }
    return map;
  }

  private async loadSurfaceComponents(): Promise<Map<string, SoulSurfaceComponent>> {
    const map = new Map<string, SoulSurfaceComponent>();
    const slugs = await subdirs(join(this.soulPath, "surface-components"));
    for (const slug of slugs) {
      const dir = join(this.soulPath, "surface-components", slug);
      try {
        const definition = (parseYaml(
          await readContainedFile(this.soulPath, join(dir, "component.yaml"))
        ) ?? {}) as Omit<SoulSurfaceComponent, "slug" | "views">;
        const views: Record<string, unknown> = {};
        for (const file of await readdir(join(dir, "views"))) {
          if (!file.endsWith(".yaml")) continue;
          views[file.slice(0, -5)] =
            parseYaml(await readContainedFile(this.soulPath, join(dir, "views", file))) ?? {};
        }
        const component = {
          ...definition,
          slug,
          views,
        } as SoulSurfaceComponent;
        validateSoulSurfaceComponent(component, this.surfaceSupport);
        map.set(component.name, component);
      } catch (err) {
        throw artifactLoadError("Surface component", slug, err);
      }
    }
    validateSoulSurfaceCatalog([...map.values()], this.surfaceSupport);
    return map;
  }

  private async loadIntegrations(): Promise<Map<string, SoulIntegration>> {
    const map = new Map<string, SoulIntegration>();
    const slugs = await subdirs(join(this.soulPath, "integrations"));
    for (const slug of slugs) {
      const dir = join(this.soulPath, "integrations", slug);
      // manifest.yml is the V2 format; manifest.json is no longer supported
      const manifestPath = join(dir, "manifest.yml");
      try {
        const parsedManifest =
          parseYaml(await readContainedFile(this.soulPath, manifestPath)) ?? {};
        const manifestRaw = validateLegacyIntegrationManifest(
          parsedManifest
        ) as IntegrationManifest;

        // Same posture as the egress check: a connect flow that can't complete is rejected at
        // load, not halfway through an operator's setup.
        const authIssues = validateAuthSteps(manifestRaw);
        if (authIssues.length > 0) {
          throw new Error(`invalid auth flow — ${authIssues.join("; ")}`);
        }

        const contextIssues = validateIngressContextEnv(manifestRaw);
        if (contextIssues.length > 0) {
          throw new Error(`invalid ingress context — ${contextIssues.join("; ")}`);
        }

        let connection: IntegrationConnection | undefined;
        try {
          const connRaw = (parseYaml(
            await readContainedFile(this.soulPath, join(dir, "connection.yaml"))
          ) ?? {}) as IntegrationConnection;
          connection = connRaw;
        } catch {
          // connection.yaml is optional — integration is installed but not yet connected
        }

        let setupGuide: string | undefined;
        try {
          setupGuide = await readContainedFile(this.soulPath, join(dir, "setup-guide.md"));
        } catch {
          // setup-guide.md is optional
        }

        // Ingress classifier module: SHA256-hashed at load so the hook executor can pin the
        // exact source it audited (same integrity posture as resource/routine hooks.ts).
        let ingressHandler: { source: string; hash: string } | undefined;
        if (manifestRaw.ingress?.handler) {
          // basename() confines the read to the integration dir (no ../ traversal).
          const handlerFile = basename(manifestRaw.ingress.handler);
          try {
            const source = await readContainedFile(this.soulPath, join(dir, handlerFile));
            ingressHandler = {
              source,
              hash: createHash("sha256").update(source).digest("hex"),
            };
          } catch (err) {
            throw new Error(
              `declares ingress.handler "${handlerFile}" but it could not be loaded: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          }
        }

        // sourceIntegration is manifest.name (the integration type from the repo).
        // slug is the directory name (user-assigned at install time, may differ for multi-instance).
        map.set(slug, {
          slug,
          sourceIntegration: manifestRaw.name,
          manifest: manifestRaw,
          connection,
          setupGuide,
          ingressHandler,
          egressSpec: await loadEgressSpec(dir, manifestRaw),
        });
      } catch (err) {
        if (err instanceof TulipFarmValidationError) {
          this.quarantine("integration", slug, `${err.path || "/"} ${err.message}`);
          continue;
        }
        throw artifactLoadError("integration", slug, err);
      }
    }
    return map;
  }

  private async loadYamlFile(path: string, label: string): Promise<Record<string, unknown> | null> {
    try {
      const content = await readContainedFile(this.soulPath, path);
      const parsed = (parseYaml(content) ?? {}) as Record<string, unknown>;
      if (label === "soul.yaml") {
        return validateSoulConfig(parsed) as Record<string, unknown>;
      }
      return parsed;
    } catch (err) {
      const isNotFound =
        err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
      if (err instanceof TulipFarmValidationError) {
        this.quarantine("configuration", label, `${err.path || "/"} ${err.message}`);
        return null;
      }
      if (!isNotFound) {
        throw artifactLoadError("configuration", label, err);
      }
      return null;
    }
  }
}
