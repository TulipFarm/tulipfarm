import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateResourceSchema } from "@tulipfarm/validation";
import { parse as parseYaml } from "yaml";
import type {
  IntegrationConnection,
  IntegrationManifest,
  Logger,
  SoulAgent,
  SoulIntegration,
  SoulResource,
  SoulRoutine,
  SoulSkill,
} from "./types";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return { frontmatter: {}, body: content.trim() };
  const frontmatter = (parseYaml(match[1]) ?? {}) as Record<string, unknown>;
  return { frontmatter, body: match[2].trim() };
}

async function subdirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

export class SoulLoader {
  agents: Map<string, SoulAgent> = new Map();
  skills: Map<string, SoulSkill> = new Map();
  resources: Map<string, SoulResource> = new Map();
  routines: Map<string, SoulRoutine> = new Map();
  integrations: Map<string, SoulIntegration> = new Map();
  llmConfig: Record<string, unknown> | null = null;
  guardrailsConfig: Record<string, unknown> | null = null;
  observabilityConfig: Record<string, unknown> | null = null;
  manifest: Record<string, unknown> | null = null;

  constructor(
    private readonly soulPath: string,
    private readonly logger: Logger
  ) {}

  async load(): Promise<void> {
    const [
      agents,
      skills,
      resources,
      routines,
      integrations,
      guardrailsConfig,
      observabilityConfig,
      manifest,
    ] = await Promise.all([
      this.loadAgents(),
      this.loadSkills(),
      this.loadResources(),
      this.loadRoutines(),
      this.loadIntegrations(),
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
    this.integrations = integrations;
    this.llmConfig = (manifest?.llm as Record<string, unknown> | undefined) ?? null;
    this.guardrailsConfig = guardrailsConfig;
    this.observabilityConfig = observabilityConfig;
    this.manifest = manifest;

    this.logger.info(
      `Soul: loaded ${agents.size} agent(s), ${skills.size} skill(s), ${resources.size} resource(s), ${routines.size} routine(s), ${integrations.size} integration(s)`
    );
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
      const path = join(this.soulPath, "agents", name, "AGENT.md");
      try {
        const content = await readFile(path, "utf8");
        const { frontmatter, body } = parseFrontmatter(content);
        map.set(name, { name, frontmatter, body });
      } catch (err) {
        this.logger.warn(
          `Soul: skipping agent "${name}" — ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return map;
  }

  private async loadSkills(): Promise<Map<string, SoulSkill>> {
    const map = new Map<string, SoulSkill>();
    const names = await subdirs(join(this.soulPath, "skills"));
    for (const name of names) {
      const path = join(this.soulPath, "skills", name, "SKILL.md");
      try {
        const content = await readFile(path, "utf8");
        const { frontmatter, body } = parseFrontmatter(content);
        map.set(name, { name, frontmatter, body });
      } catch (err) {
        this.logger.warn(
          `Soul: skipping skill "${name}" — ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return map;
  }

  private async loadResources(): Promise<Map<string, SoulResource>> {
    const map = new Map<string, SoulResource>();
    const names = await subdirs(join(this.soulPath, "resources"));
    for (const name of names) {
      const schemaPath = join(this.soulPath, "resources", name, "schema.yml");
      try {
        const content = await readFile(schemaPath, "utf8");
        const schema = (parseYaml(content) ?? {}) as Record<string, unknown>;
        validateResourceSchema(schema);
        const hooksPath = join(this.soulPath, "resources", name, "hooks.ts");
        const hasHooks = await fileExists(hooksPath);
        const hookSource = hasHooks ? await readFile(hooksPath, "utf8") : undefined;
        const hookHash = hookSource
          ? createHash("sha256").update(hookSource).digest("hex")
          : undefined;
        const hooksEnabled = schema["x-hooks-enabled"] !== false;
        map.set(name, { name, schema, hasHooks, hookSource, hookHash, hooksEnabled });
      } catch (err) {
        this.logger.warn(
          `Soul: skipping resource "${name}" — ${err instanceof Error ? err.message : String(err)}`
        );
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
        const content = await readFile(configPath, "utf8");
        const config = (parseYaml(content) ?? {}) as Record<string, unknown>;
        const hasHooks = await fileExists(join(this.soulPath, "routines", name, "hooks.ts"));
        map.set(name, { name, config, hasHooks });
      } catch (err) {
        this.logger.warn(
          `Soul: skipping routine "${name}" — ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
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
        const manifestRaw = (parseYaml(await readFile(manifestPath, "utf8")) ??
          {}) as IntegrationManifest;

        // Validate egress block minimally
        if (!manifestRaw.egress?.type) {
          this.logger.warn(`Soul: skipping integration "${slug}" — manifest.egress.type missing`);
          continue;
        }
        if (manifestRaw.egress.type === "mcp" && !manifestRaw.egress.entry?.transport) {
          this.logger.warn(
            `Soul: skipping integration "${slug}" — manifest.egress.entry.transport missing`
          );
          continue;
        }

        let connection: IntegrationConnection | undefined;
        try {
          const connRaw = (parseYaml(await readFile(join(dir, "connection.yaml"), "utf8")) ??
            {}) as IntegrationConnection;
          connection = connRaw;
        } catch {
          // connection.yaml is optional — integration is installed but not yet connected
        }

        let setupGuide: string | undefined;
        try {
          setupGuide = await readFile(join(dir, "setup-guide.md"), "utf8");
        } catch {
          // setup-guide.md is optional
        }

        // sourceIntegration is manifest.name (the integration type from the repo).
        // slug is the directory name (user-assigned at install time, may differ for multi-instance).
        map.set(slug, {
          slug,
          sourceIntegration: manifestRaw.name,
          manifest: manifestRaw,
          connection,
          setupGuide,
        });
      } catch (err) {
        this.logger.warn(
          `Soul: skipping integration "${slug}" — ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return map;
  }

  private async loadYamlFile(path: string, label: string): Promise<Record<string, unknown> | null> {
    try {
      const content = await readFile(path, "utf8");
      return (parseYaml(content) ?? {}) as Record<string, unknown>;
    } catch (err) {
      const isNotFound =
        err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
      if (!isNotFound) {
        this.logger.warn(
          `Soul: skipping ${label} — ${err instanceof Error ? err.message : String(err)}`
        );
      }
      return null;
    }
  }
}
