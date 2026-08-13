import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SoulLoader } from "./published-loader";

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
        join(TMP, "roles"),
        join(TMP, "integrations")
      );
      const loader = new SoulLoader(TMP, makeLogger());
      await expect(loader.load()).resolves.toBeUndefined();
      expect(loader.agents.size).toBe(0);
      expect(loader.skills.size).toBe(0);
      expect(loader.resources.size).toBe(0);
      expect(loader.routines.size).toBe(0);
      expect(loader.roles.size).toBe(0);
      expect(loader.integrations.size).toBe(0);
      expect(loader.surfaceComponents.size).toBe(0);
      expect(loader.llmConfig).toBeNull();
      expect(loader.guardrailsConfig).toBeNull();
      expect(loader.manifest).toBeNull();
    });

    it("quarantines a manifest.yml that fails the legacy integration schema", async () => {
      await write(
        join(TMP, "integrations", "broken", "manifest.yml"),
        "name: broken\negress:\n  type: openapi\n  spec: 123\n"
      );
      await write(
        join(TMP, "integrations", "healthy", "manifest.yml"),
        "name: healthy\negress:\n  type: none\n"
      );
      const loader = new SoulLoader(TMP, makeLogger());

      await loader.load();

      expect(loader.integrations.has("broken")).toBe(false);
      expect(loader.integrations.has("healthy")).toBe(true);
      expect(loader.quarantined).toContainEqual({
        kind: "integration",
        name: "broken",
        reason: expect.stringContaining("/egress"),
      });
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

    it("quarantines a published agent with no definition file instead of failing the whole load", async () => {
      // Per decision S3: boot never crashes on one bad artifact. Throwing here took the entire
      // catalog down with it — `load()` runs every loader under `Promise.all`, so one empty agent
      // directory also cost every skill, resource, routine and integration.
      await mkdirs(join(TMP, "agents", "broken"));
      await write(join(TMP, "skills", "healthy", "SKILL.md"), "Still loads.");
      const loader = new SoulLoader(TMP, makeLogger());

      await loader.load();

      expect(loader.agents.has("broken")).toBe(false);
      expect(loader.quarantined).toContainEqual({
        kind: "agent",
        name: "broken",
        reason: "no agent.yaml or AGENT.md in the directory",
      });
      // The point of quarantining rather than throwing: unrelated artifacts survive.
      expect(loader.skills.get("healthy")?.body).toBe("Still loads.");
    });

    it("still fails closed when a definition exists but cannot be read", async () => {
      // Absent and corrupt are different: nothing to misinterpret vs. something we cannot trust.
      await write(
        join(TMP, "agents", "bad-yaml", "agent.yaml"),
        "apiVersion: tulipfarm.ai/v1\nkind: Agent\nspec:\n  instructions:\n    path: missing.md\n"
      );
      const loader = new SoulLoader(TMP, makeLogger());
      await expect(loader.load()).rejects.toThrow('agent "bad-yaml"');
    });
  });

  describe("canonical layout", () => {
    // The regression that matters most: the writer emits `agent.yaml`, the loader used to read
    // only `AGENT.md`. A successful write made the agent vanish, and the throw took the whole
    // catalog with it. Both halves now resolve the path through the same registry.
    it("reads a canonical agent.yaml + instructions.md pair", async () => {
      await write(
        join(TMP, "agents", "triage", "agent.yaml"),
        [
          "apiVersion: tulipfarm.ai/v1",
          "kind: Agent",
          "metadata:",
          "  slug: triage",
          "  displayName: Triage",
          "spec:",
          "  owner: ops@example.com",
          "  modelProfile: balanced",
          "  autonomy: propose_actions",
          "  trustTier: business_authored",
          "  instructions:",
          "    path: instructions.md",
          "",
        ].join("\n")
      );
      await write(join(TMP, "agents", "triage", "instructions.md"), "Triage things.");

      const loader = new SoulLoader(TMP, makeLogger());
      await loader.load();

      const agent = loader.agents.get("triage");
      expect(agent?.body).toBe("Triage things.");
      expect(agent?.frontmatter).toMatchObject({
        owner: "ops@example.com",
        modelProfile: "balanced",
        autonomy: "propose_actions",
        trustTier: "business_authored",
        name: "Triage",
      });
      // `instructions` is a file pointer, not configuration — it must not leak into the view
      // consumers treat as frontmatter.
      expect(agent?.frontmatter.instructions).toBeUndefined();
    });

    it("prefers the canonical definition when both layouts are present", async () => {
      await write(join(TMP, "agents", "dual", "AGENT.md"), "---\nowner: legacy\n---\nLegacy body.");
      await write(
        join(TMP, "agents", "dual", "agent.yaml"),
        [
          "apiVersion: tulipfarm.ai/v1",
          "kind: Agent",
          "metadata:",
          "  slug: dual",
          "spec:",
          "  owner: canonical",
          "  instructions:",
          "    path: instructions.md",
          "",
        ].join("\n")
      );
      await write(join(TMP, "agents", "dual", "instructions.md"), "Canonical body.");

      const loader = new SoulLoader(TMP, makeLogger());
      await loader.load();

      expect(loader.agents.get("dual")?.frontmatter.owner).toBe("canonical");
      expect(loader.agents.get("dual")?.body).toBe("Canonical body.");
    });

    it("reads a canonical resource.yaml", async () => {
      await write(
        join(TMP, "resources", "ticket", "resource.yaml"),
        [
          "apiVersion: tulipfarm.ai/v1",
          "kind: Resource",
          "metadata:",
          "  id: 00000000-0000-4000-8000-000000000001",
          "  slug: ticket",
          "  schemaVersion: 1",
          "  authoredVersion: 1",
          "  lifecycle: draft",
          "spec:",
          "  domain: engineering",
          "  recordSchema:",
          "    type: object",
          "    properties:",
          "      title:",
          "        type: string",
          "",
        ].join("\n")
      );
      const loader = new SoulLoader(TMP, makeLogger());
      await loader.load();
      expect(loader.resources.get("ticket")?.schema).toMatchObject({ type: "object" });
      expect(loader.resources.get("ticket")?.domain).toBe("engineering");
    });

    // Regression: an envelope-shaped `resource.yaml` that fails validation used to be swallowed and
    // fall back to the legacy path, which reinterpreted the whole envelope as the Record schema
    // *and silently dropped `spec.domain`* — loading an `hr` Resource as domainless, which the
    // member allow-list grants every member `record.*` on. It must fail loudly instead.
    it("fails loudly on an invalid resource.yaml rather than loading it without its domain", async () => {
      await write(
        join(TMP, "resources", "salary-review", "resource.yaml"),
        [
          "apiVersion: tulipfarm.ai/v1",
          "kind: Resource",
          "metadata:",
          "  id: 00000000-0000-4000-8000-000000000009",
          "  slug: salary-review",
          "  schemaVersion: 1",
          "  authoredVersion: 1",
          "  lifecycle: not-a-real-lifecycle",
          "spec:",
          "  domain: hr",
          "  recordSchema:",
          "    type: object",
          "    properties:",
          "      band:",
          "        type: string",
          "",
        ].join("\n")
      );

      const loader = new SoulLoader(TMP, makeLogger());
      await expect(loader.load()).rejects.toThrow(/salary-review/);
    });

    it("reads a canonical role.yaml", async () => {
      await write(
        join(TMP, "roles", "support-operator", "role.yaml"),
        [
          "apiVersion: tulipfarm.ai/v1",
          "kind: Role",
          "metadata:",
          "  id: 11111111-1111-4111-8111-111111111111",
          "  slug: support-operator",
          "  schemaVersion: 1",
          "  authoredVersion: 1",
          "  lifecycle: published",
          "spec:",
          "  principalTypes: [user, agent, routine, integration_adapter, api, service]",
          "  grants:",
          "    - effect: allow",
          "      actions: [ticket.read]",
          "      resource:",
          "        types: [record.ticket]",
          "      domains: ['*']",
          "      delegable: false",
          "",
        ].join("\n")
      );

      const loader = new SoulLoader(TMP, makeLogger());
      await loader.load();

      const role = loader.roles.get("support-operator");
      expect(role?.definition.kind).toBe("Role");
      expect(role?.definition.spec.principalTypes).toEqual([
        "user",
        "agent",
        "routine",
        "integration_adapter",
        "api",
        "service",
      ]);
      expect(role?.definition.spec.grants[0]?.domains).toEqual(["*"]);
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

  describe("Surface components", () => {
    it("loads and validates a published declarative composition", async () => {
      await write(
        join(TMP, "surface-components", "release-status", "component.yaml"),
        [
          "name: business.release-status",
          'version: "1.0"',
          "description: Release readiness",
          "propsSchema:",
          "  type: object",
          "  required: [label]",
          "  properties:",
          "    label: { type: string }",
          "events: []",
          "examples:",
          "  - label: Ready",
          "targets:",
          "  - channel: web",
          "    surface: chat",
        ].join("\n")
      );
      await write(
        join(TMP, "surface-components", "release-status", "views", "default.yaml"),
        [
          "component:",
          "  name: Status",
          '  version: "1.0"',
          "props:",
          "  label:",
          '    $prop: "/label"',
          "  tone: positive",
        ].join("\n")
      );
      const loader = new SoulLoader(TMP, makeLogger());
      await loader.load();
      expect(loader.surfaceComponents.get("business.release-status")).toMatchObject({
        slug: "release-status",
        version: "1.0",
      });
    });

    it("fails closed when a composition references an unknown version", async () => {
      await write(
        join(TMP, "surface-components", "release-status", "component.yaml"),
        [
          "name: business.release-status",
          'version: "1.0"',
          "description: Release readiness",
          "propsSchema:",
          "  type: object",
          "  required: [label]",
          "  properties:",
          "    label: { type: string }",
          "events: []",
          "examples:",
          "  - label: Ready",
          "targets:",
          "  - channel: web",
          "    surface: chat",
        ].join("\n")
      );
      await write(
        join(TMP, "surface-components", "release-status", "views", "default.yaml"),
        [
          "component:",
          "  name: Status",
          '  version: "9.0"',
          "props:",
          "  label:",
          '    $prop: "/label"',
        ].join("\n")
      );
      const loader = new SoulLoader(TMP, makeLogger());
      await expect(loader.load()).rejects.toThrow("unknown component Status@9.0");
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

    it("fails closed when hooks.ts exists but cannot be read as a file", async () => {
      await write(join(TMP, "resources", "ticket", "schema.yml"), "type: object\n");
      await mkdirs(join(TMP, "resources", "ticket", "hooks.ts"));
      const loader = new SoulLoader(TMP, makeLogger());
      await expect(loader.load()).rejects.toThrow('resource "ticket"');
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

    it("fails closed when a published resource contains invalid YAML", async () => {
      await write(join(TMP, "resources", "bad", "schema.yml"), "{ broken yaml: [}");
      await write(join(TMP, "resources", "good", "schema.yml"), "type: object\n");
      const loader = new SoulLoader(TMP, makeLogger());
      await expect(loader.load()).rejects.toThrow('resource "bad"');
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

    it("reads hookSource and computes hookHash when hooks.ts exists", async () => {
      const hookSource = "({ beforeHook(ctx) { return ctx; } })";
      await write(join(TMP, "routines", "hooked", "routine.yaml"), "name: hooked\n");
      await write(join(TMP, "routines", "hooked", "hooks.ts"), hookSource);
      await write(join(TMP, "routines", "bare", "routine.yaml"), "name: bare\n");
      const loader = new SoulLoader(TMP, makeLogger());
      await loader.load();
      const hooked = loader.routines.get("hooked");
      expect(hooked?.hookSource).toBe(hookSource);
      expect(hooked?.hookHash).toMatch(/^[0-9a-f]{64}$/);
      const bare = loader.routines.get("bare");
      expect(bare?.hasHooks).toBe(false);
      expect(bare?.hookSource).toBeUndefined();
      expect(bare?.hookHash).toBeUndefined();
    });
  });

  describe("integrations", () => {
    it("parses config.yaml", async () => {
      await write(
        join(TMP, "integrations", "github", "manifest.yml"),
        "name: github\negress:\n  type: mcp\n  entry:\n    transport: stdio\n    command: echo\n"
      );
      await write(
        join(TMP, "integrations", "github", "connection.yaml"),
        "enabled: true\nenv:\n  token: ghp_xxx\n  owner: tulipfarm\n"
      );
      const loader = new SoulLoader(TMP, makeLogger());
      await loader.load();
      expect(loader.integrations.get("github")?.connection?.env).toMatchObject({
        token: "ghp_xxx",
        owner: "tulipfarm",
      });
    });

    it("loads and hashes the declared ingress handler module", async () => {
      const handler = "export function classify(input) { return { kind: 'ignore' }; }\n";
      await write(
        join(TMP, "integrations", "chatapp", "manifest.yml"),
        [
          "name: chatapp",
          "egress:",
          "  type: mcp",
          "  entry:",
          "    transport: stdio",
          "    command: echo",
          "ingress:",
          "  handler: ingress.ts",
          "  webhook:",
          "    security:",
          "      type: hmac_sha256",
          "      header: X-Sig",
          "      secret_env: SECRET",
          "",
        ].join("\n")
      );
      await write(join(TMP, "integrations", "chatapp", "ingress.ts"), handler);
      const loader = new SoulLoader(TMP, makeLogger());
      await loader.load();
      const loaded = loader.integrations.get("chatapp");
      expect(loaded?.ingressHandler?.source).toBe(handler);
      expect(loaded?.ingressHandler?.hash).toBe(createHash("sha256").update(handler).digest("hex"));
    });

    it("fails closed when a declared ingress handler is missing", async () => {
      await write(
        join(TMP, "integrations", "broken", "manifest.yml"),
        "name: broken\negress:\n  type: mcp\n  entry:\n    transport: stdio\n    command: echo\ningress:\n  handler: ingress.ts\n  webhook:\n    security:\n      type: hmac_sha256\n      header: X-Sig\n      secret_env: SECRET\n"
      );
      const loader = new SoulLoader(TMP, makeLogger());
      await expect(loader.load()).rejects.toThrow("declares ingress.handler");
    });

    it("confines the handler path to the integration dir (basename only)", async () => {
      await write(join(TMP, "outside.ts"), "export function classify() {}\n");
      await write(
        join(TMP, "integrations", "sneaky", "manifest.yml"),
        "name: sneaky\negress:\n  type: mcp\n  entry:\n    transport: stdio\n    command: echo\ningress:\n  handler: ../../outside.ts\n  webhook:\n    security:\n      type: hmac_sha256\n      header: X-Sig\n      secret_env: SECRET\n"
      );
      const loader = new SoulLoader(TMP, makeLogger());
      // basename() reduces ../../outside.ts to outside.ts inside the integration dir → missing.
      await expect(loader.load()).rejects.toThrow('ingress.handler "outside.ts"');
    });
  });

  describe("llmConfig and manifest", () => {
    it("parses llm from soul.yaml's nested `llm:` key", async () => {
      await write(
        join(TMP, "soul.yaml"),
        [
          "name: my-instance",
          "llm:",
          "  tiers:",
          "    quick:",
          "      providers:",
          "        - provider: anthropic",
          "          model: claude-haiku-4-5",
          "    standard:",
          "      providers:",
          "        - provider: anthropic",
          "          model: claude-sonnet-4-6",
          "    complex:",
          "      providers:",
          "        - provider: anthropic",
          "          model: claude-opus-4-8",
          "",
        ].join("\n")
      );
      const loader = new SoulLoader(TMP, makeLogger());
      await loader.load();
      expect(loader.llmConfig).toMatchObject({ tiers: { standard: expect.any(Object) } });
      expect(loader.manifest).toMatchObject({ name: "my-instance" });
    });

    it("quarantines an invalid soul.yaml instead of crashing boot", async () => {
      await write(join(TMP, "soul.yaml"), "setupComplete: yes\n");
      await write(join(TMP, "skills", "healthy", "SKILL.md"), "Still loads.");
      const loader = new SoulLoader(TMP, makeLogger());

      await loader.load();

      expect(loader.manifest).toBeNull();
      expect(loader.skills.get("healthy")?.body).toBe("Still loads.");
      expect(loader.quarantined).toContainEqual({
        kind: "configuration",
        name: "soul.yaml",
        reason: "/setupComplete must be boolean",
      });
    });

    it("returns null for missing soul.yaml without warn", async () => {
      const logger = makeLogger();
      const loader = new SoulLoader(TMP, logger);
      await loader.load();
      expect(loader.llmConfig).toBeNull();
      expect(loader.manifest).toBeNull();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("returns null llmConfig when soul.yaml has no `llm:` key", async () => {
      await write(join(TMP, "soul.yaml"), "name: my-instance\n");
      const loader = new SoulLoader(TMP, makeLogger());
      await loader.load();
      expect(loader.llmConfig).toBeNull();
      expect(loader.manifest).toMatchObject({ name: "my-instance" });
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
