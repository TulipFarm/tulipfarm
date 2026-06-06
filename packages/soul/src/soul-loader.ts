import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { validateResourceSchema } from "@tulipfarm/validation";
import { parse as parseYaml } from "yaml";
import type { SoulAgent, SoulIntegration, SoulResource, SoulRoutine, SoulSkill } from "./types";

interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

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
  manifest: Record<string, unknown> | null = null;

  constructor(
    private readonly soulPath: string,
    private readonly logger: Logger
  ) {}

  async load(): Promise<void> {
    const [agents, skills, resources, routines, integrations, llmConfig, manifest] =
      await Promise.all([
        this.loadAgents(),
        this.loadSkills(),
        this.loadResources(),
        this.loadRoutines(),
        this.loadIntegrations(),
        this.loadYamlFile(join(this.soulPath, "llm.config.yaml"), "llm.config.yaml"),
        this.loadYamlFile(join(this.soulPath, "soul.yaml"), "soul.yaml"),
      ]);

    this.agents = agents;
    this.skills = skills;
    this.resources = resources;
    this.routines = routines;
    this.integrations = integrations;
    this.llmConfig = llmConfig;
    this.manifest = manifest;

    this.logger.info(
      `Soul: loaded ${agents.size} agent(s), ${skills.size} skill(s), ${resources.size} resource(s), ${routines.size} routine(s), ${integrations.size} integration(s)`
    );
  }

  async reload(): Promise<void> {
    await this.load();
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
        const hasHooks = await fileExists(join(this.soulPath, "resources", name, "hooks.ts"));
        map.set(name, { name, schema, hasHooks });
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
    const names = await subdirs(join(this.soulPath, "integrations"));
    for (const name of names) {
      const connPath = join(this.soulPath, "integrations", name, "connection.yaml");
      try {
        const content = await readFile(connPath, "utf8");
        const connection = (parseYaml(content) ?? {}) as Record<string, unknown>;
        map.set(name, { name, connection });
      } catch (err) {
        this.logger.warn(
          `Soul: skipping integration "${name}" — ${err instanceof Error ? err.message : String(err)}`
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
