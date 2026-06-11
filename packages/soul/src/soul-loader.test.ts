import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SoulLoader } from "./soul-loader";

const TMP = join(import.meta.dirname, "__soul_test_tmp__");

async function mkdirs(...paths: string[]) {
  for (const p of paths) await mkdir(p, { recursive: true });
}

async function write(path: string, content: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

beforeEach(() => mkdirs(TMP));
afterEach(() => rm(TMP, { recursive: true, force: true }));

describe("SoulLoader", () => {
  describe("empty soul dir", () => {
    it("loads with all maps empty, no throw", async () => {
      await mkdirs(
        join(TMP, "agents"),
        join(TMP, "skills"),
        join(TMP, "resources"),
        join(TMP, "routines"),
        join(TMP, "integrations")
      );
      const loader = new SoulLoader(TMP, makeLogger());
      await expect(loader.load()).resolves.toBeUndefined();
      expect(loader.agents.size).toBe(0);
      expect(loader.skills.size).toBe(0);
      expect(loader.resources.size).toBe(0);
      expect(loader.routines.size).toBe(0);
      expect(loader.integrations.size).toBe(0);
      expect(loader.llmConfig).toBeNull();
      expect(loader.guardrailsConfig).toBeNull();
      expect(loader.manifest).toBeNull();
    });
  });

  describe("agents", () => {
    it("parses AGENT.md with frontmatter and body", async () => {
      await write(
        join(TMP, "agents", "tulip-agent", "AGENT.md"),
        "---\nname: tulip-agent\nversion: 1.0.0\n---\n# Agent Body\nDoes things."
      );
      const loader = new SoulLoader(TMP, makeLogger());
      await loader.load();
      expect(loader.agents.size).toBe(1);
      expect(loader.agents.get("tulip-agent")?.name).toBe("tulip-agent");
      expect(loader.agents.get("tulip-agent")?.frontmatter).toMatchObject({
        name: "tulip-agent",
        version: "1.0.0",
      });
      expect(loader.agents.get("tulip-agent")?.body).toBe("# Agent Body\nDoes things.");
    });

    it("parses AGENT.md with no frontmatter", async () => {
      await write(join(TMP, "agents", "plain", "AGENT.md"), "Just body text.");
      const loader = new SoulLoader(TMP, makeLogger());
      await loader.load();
      expect(loader.agents.get("plain")?.frontmatter).toEqual({});
      expect(loader.agents.get("plain")?.body).toBe("Just body text.");
    });

    it("skips agent with missing AGENT.md, logs warn", async () => {
      await mkdirs(join(TMP, "agents", "broken"));
      const logger = makeLogger();
      const loader = new SoulLoader(TMP, logger);
      await loader.load();
      expect(loader.agents.size).toBe(0);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("broken"));
    });
  });

  describe("skills", () => {
    it("parses SKILL.md with frontmatter and body", async () => {
      await write(
        join(TMP, "skills", "my-skill", "SKILL.md"),
        "---\nname: my-skill\ntags:\n  - foo\n---\nSkill body here."
      );
      const loader = new SoulLoader(TMP, makeLogger());
      await loader.load();
      expect(loader.skills.get("my-skill")?.frontmatter).toMatchObject({
        name: "my-skill",
        tags: ["foo"],
      });
      expect(loader.skills.get("my-skill")?.body).toBe("Skill body here.");
    });
  });

  describe("resources", () => {
    it("parses schema.yml, detects missing hooks.ts", async () => {
      await write(
        join(TMP, "resources", "ticket", "schema.yml"),
        "type: object\nproperties:\n  title:\n    type: string\n"
      );
      const loader = new SoulLoader(TMP, makeLogger());
      await loader.load();
      expect(loader.resources.get("ticket")?.schema).toMatchObject({ type: "object" });
      expect(loader.resources.get("ticket")?.hasHooks).toBe(false);
    });

    it("detects present hooks.ts and sets hasHooks=true", async () => {
      await write(join(TMP, "resources", "ticket", "schema.yml"), "type: object\n");
      await write(join(TMP, "resources", "ticket", "hooks.ts"), "export default {}");
      const loader = new SoulLoader(TMP, makeLogger());
      await loader.load();
      expect(loader.resources.get("ticket")?.hasHooks).toBe(true);
    });

    it("reads hooks.ts source into hookSource when present", async () => {
      const hookContent = "({ before(ctx) { ctx.patch({ x: 1 }); } })";
      await write(join(TMP, "resources", "ticket", "schema.yml"), "type: object\n");
      await write(join(TMP, "resources", "ticket", "hooks.ts"), hookContent);
      const loader = new SoulLoader(TMP, makeLogger());
      await loader.load();
      expect(loader.resources.get("ticket")?.hookSource).toBe(hookContent);
    });

    it("hookSource is undefined when hooks.ts absent", async () => {
      await write(join(TMP, "resources", "ticket", "schema.yml"), "type: object\n");
      const loader = new SoulLoader(TMP, makeLogger());
      await loader.load();
      expect(loader.resources.get("ticket")?.hookSource).toBeUndefined();
    });

    it("hooksEnabled defaults to true when x-hooks-enabled absent", async () => {
      await write(join(TMP, "resources", "ticket", "schema.yml"), "type: object\n");
      const loader = new SoulLoader(TMP, makeLogger());
      await loader.load();
      expect(loader.resources.get("ticket")?.hooksEnabled).toBe(true);
    });

    it("hooksEnabled is false when x-hooks-enabled: false in schema", async () => {
      await write(
        join(TMP, "resources", "ticket", "schema.yml"),
        "type: object\nx-hooks-enabled: false\n"
      );
      const loader = new SoulLoader(TMP, makeLogger());
      await loader.load();
      expect(loader.resources.get("ticket")?.hooksEnabled).toBe(false);
    });

    it("hookHash is sha256 of hookSource when hooks.ts present", async () => {
      const hookContent = "({ before(ctx) { ctx.patch({ x: 1 }); } })";
      await write(join(TMP, "resources", "ticket", "schema.yml"), "type: object\n");
      await write(join(TMP, "resources", "ticket", "hooks.ts"), hookContent);
      const loader = new SoulLoader(TMP, makeLogger());
      await loader.load();
      const expected = createHash("sha256").update(hookContent).digest("hex");
      expect(loader.resources.get("ticket")?.hookHash).toBe(expected);
    });

    it("hookHash is undefined when hooks.ts absent", async () => {
      await write(join(TMP, "resources", "ticket", "schema.yml"), "type: object\n");
      const loader = new SoulLoader(TMP, makeLogger());
      await loader.load();
      expect(loader.resources.get("ticket")?.hookHash).toBeUndefined();
    });

    it("warns on reload when hookSource changes (integrity check)", async () => {
      const schemaPath = join(TMP, "resources", "ticket", "schema.yml");
      const hooksPath = join(TMP, "resources", "ticket", "hooks.ts");
      await write(schemaPath, "type: object\n");
      await write(hooksPath, "({ before() {} })");
      const logger = makeLogger();
      const loader = new SoulLoader(TMP, logger);
      await loader.load();
      await write(hooksPath, "({ before() { /* modified */ } })");
      await loader.reload();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('hook integrity: hash changed for resource "ticket"')
      );
    });

    it("does not warn on reload when hookSource unchanged", async () => {
      const content = "({ before() {} })";
      await write(join(TMP, "resources", "ticket", "schema.yml"), "type: object\n");
      await write(join(TMP, "resources", "ticket", "hooks.ts"), content);
      const logger = makeLogger();
      const loader = new SoulLoader(TMP, logger);
      await loader.load();
      await loader.reload();
      expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("hook integrity"));
    });

    it("skips resource with invalid YAML, logs warn, others still load", async () => {
      await write(join(TMP, "resources", "bad", "schema.yml"), "{ broken yaml: [}");
      await write(join(TMP, "resources", "good", "schema.yml"), "type: object\n");
      const logger = makeLogger();
      const loader = new SoulLoader(TMP, logger);
      await loader.load();
      expect(loader.resources.has("bad")).toBe(false);
      expect(loader.resources.has("good")).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("bad"));
    });
  });

  describe("routines", () => {
    it("parses routine.yaml and detects hooks.ts", async () => {
      await write(
        join(TMP, "routines", "daily-report", "routine.yaml"),
        "schedule: '0 9 * * *'\nname: daily-report\n"
      );
      await write(join(TMP, "routines", "daily-report", "hooks.ts"), "export default {}");
      const loader = new SoulLoader(TMP, makeLogger());
      await loader.load();
      expect(loader.routines.get("daily-report")?.config).toMatchObject({
        schedule: "0 9 * * *",
      });
      expect(loader.routines.get("daily-report")?.hasHooks).toBe(true);
    });
  });

  describe("integrations", () => {
    it("parses connection.yaml", async () => {
      await write(
        join(TMP, "integrations", "github", "connection.yaml"),
        "token: ghp_xxx\nowner: tulipfarm\n"
      );
      const loader = new SoulLoader(TMP, makeLogger());
      await loader.load();
      expect(loader.integrations.get("github")?.connection).toMatchObject({
        token: "ghp_xxx",
        owner: "tulipfarm",
      });
    });
  });

  describe("llmConfig and manifest", () => {
    it("parses llm.config.yaml and soul.yaml", async () => {
      await write(join(TMP, "llm.config.yaml"), "provider: anthropic\nmodel: claude-sonnet-4-6\n");
      await write(join(TMP, "soul.yaml"), "name: my-instance\n");
      const loader = new SoulLoader(TMP, makeLogger());
      await loader.load();
      expect(loader.llmConfig).toMatchObject({ provider: "anthropic" });
      expect(loader.manifest).toMatchObject({ name: "my-instance" });
    });

    it("returns null for missing llm.config.yaml and soul.yaml without warn", async () => {
      const logger = makeLogger();
      const loader = new SoulLoader(TMP, logger);
      await loader.load();
      expect(loader.llmConfig).toBeNull();
      expect(loader.manifest).toBeNull();
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe("guardrailsConfig", () => {
    it("parses guardrails.yaml", async () => {
      await write(
        join(TMP, "guardrails.yaml"),
        "input:\n  - name: pii-redactor\noutput:\n  - name: tone-check\n"
      );
      const loader = new SoulLoader(TMP, makeLogger());
      await loader.load();
      expect(loader.guardrailsConfig).toEqual({
        input: [{ name: "pii-redactor" }],
        output: [{ name: "tone-check" }],
      });
    });

    it("returns null for missing guardrails.yaml without warn", async () => {
      const logger = makeLogger();
      const loader = new SoulLoader(TMP, logger);
      await loader.load();
      expect(loader.guardrailsConfig).toBeNull();
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe("reload", () => {
    it("replaces prior state on reload", async () => {
      await write(join(TMP, "agents", "agent-a", "AGENT.md"), "---\nname: agent-a\n---\nBody A.");
      const loader = new SoulLoader(TMP, makeLogger());
      await loader.load();
      expect(loader.agents.size).toBe(1);

      await write(join(TMP, "agents", "agent-b", "AGENT.md"), "---\nname: agent-b\n---\nBody B.");
      await loader.reload();
      expect(loader.agents.size).toBe(2);
      expect(loader.agents.has("agent-b")).toBe(true);
    });
  });
});
