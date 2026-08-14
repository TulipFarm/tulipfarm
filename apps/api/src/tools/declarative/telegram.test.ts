import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ajv } from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import type { IntegrationManifest, SoulIntegration, ToolBinding } from "@tulipfarm/soul";
import {
  validateAuthSteps,
  validateIngressContextEnv,
  validateThirdPartyManifest,
} from "@tulipfarm/soul";
import { MemoryEffectStore } from "@tulipfarm/tool-broker";
import { beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { renderVarTemplate } from "../../ingress/template";
import { bundledIntegrationsDir } from "../../soul/integrations/bundled";
import { buildDeclarativeTools, declarativeToolName } from "./tools";

describe("telegram bundled integration", () => {
  let manifest: IntegrationManifest;
  let spec: unknown;
  let handler: string;

  beforeAll(async () => {
    const dir = join(bundledIntegrationsDir(), "telegram");
    manifest = parseYaml(await readFile(join(dir, "manifest.yml"), "utf8")) as IntegrationManifest;
    spec = parseYaml(await readFile(join(dir, "openapi.json"), "utf8"));
    handler = await readFile(join(dir, "ingress.ts"), "utf8");
  });

  const build = () =>
    buildDeclarativeTools(
      [
        {
          slug: "telegram",
          sourceIntegration: "telegram",
          manifest,
          egressSpec: spec,
          connection: { enabled: true, env: {} },
        } as SoulIntegration,
      ],
      {
        businessId: "biz",
        effects: new MemoryEffectStore(),
        secrets: async () => ({}) as SecretsService,
        http: { send: async () => ({ status: 200, headers: {}, body: {} }) },
      }
    );

  it("declares both halves of a channel — egress Tools and webhook ingress", () => {
    expect(manifest.egress?.type).toBe("openapi");
    expect(manifest.ingress?.webhook.security.type).toBe("shared_secret");
    expect(manifest.ingress?.handler).toBe("ingress.ts");
  });

  it("declares a connect flow and a classifier context the loader accepts", () => {
    expect(validateAuthSteps(manifest)).toEqual([]);
    expect(validateIngressContextEnv(manifest)).toEqual([]);
  });

  it("is bundled, because a channel is code and third-party ingress stays refused", () => {
    expect(validateThirdPartyManifest(manifest)).toEqual([
      "ingress.handler is a code module; third-party integrations cannot declare ingress in this version",
    ]);
  });

  it("compiles every declared operation with no problems", () => {
    const { tools, problems } = build();
    expect(problems).toEqual([]);
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "telegram_read_chat",
      "telegram_read_chat_member",
      "telegram_send_message",
    ]);
  });

  it("carries the credential in the path, which is where Telegram wants it", () => {
    expect(manifest.egress?.type === "openapi" && manifest.egress.base_url).toBe(
      "https://api.telegram.org/bot{token}"
    );
    expect(manifest.egress?.type === "openapi" && manifest.egress.auth?.in).toBe("base_url");
  });

  it("gates sending behind approval and leaves lookups ungated", () => {
    const mutating = Object.fromEntries(build().tools.map((tool) => [tool.name, tool.mutating]));
    expect(mutating.telegram_send_message).toBe(true);
    expect(mutating.telegram_read_chat).toBe(false);
    expect(mutating.telegram_read_chat_member).toBe(false);
  });

  it("registers the webhook under the very secret ingress verifies deliveries with", () => {
    const step = manifest.auth?.find((entry) => entry.kind === "webhook");
    expect(step?.kind === "webhook" && step.secret_env).toBe(
      manifest.ingress?.webhook.security.secret_env
    );
  });

  it("tells the classifier its own @username, and nothing secret", () => {
    expect(manifest.ingress?.context_env).toEqual(["TELEGRAM_BOT_USERNAME"]);
    expect(handler).toContain("env.TELEGRAM_BOT_USERNAME");
  });

  it("binds replies to Tools it actually publishes", () => {
    const names = new Set(build().tools.map((tool) => tool.name));
    const bindings: ToolBinding[] = [
      ...Object.values(manifest.ingress?.chat?.reply ?? {}),
      ...(manifest.ingress?.chat?.identity ? [manifest.ingress.chat.identity] : []),
    ];

    expect(bindings.length).toBeGreaterThan(0);
    for (const binding of bindings) {
      expect(names).toContain(declarativeToolName("telegram", binding.tool));
    }
  });

  it("fills those Tools with arguments their own schemas accept", () => {
    const tools = new Map(build().tools.map((tool) => [tool.name, tool]));
    const vars = { chat: "-100", message: "7", topic: "31", sender: "42", text: "hello" };

    for (const [name, binding] of Object.entries(manifest.ingress?.chat?.reply ?? {})) {
      const tool = tools.get(declarativeToolName("telegram", binding.tool));
      const validate = ajv.compile(tool?.inputSchema ?? {});
      const args = render(binding.args, vars);
      expect(
        validate(args),
        `reply binding "${name}" → ${binding.tool}: ${ajv.errorsText(validate.errors)}`
      ).toBe(true);
    }
  });

  it("addresses people by name rather than by numeric id", () => {
    const identity = manifest.ingress?.chat?.identity;
    const tools = new Map(build().tools.map((tool) => [tool.name, tool]));
    const tool = tools.get(declarativeToolName("telegram", identity?.tool ?? ""));
    const validate = ajv.compile(tool?.inputSchema ?? {});
    const args = render(identity?.args ?? {}, { chat: "-100", sender: "42" });

    expect(validate(args), ajv.errorsText(validate.errors)).toBe(true);
  });
});

function render(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === "string") return renderVarTemplate(value, vars);
  if (Array.isArray(value)) return value.map((entry) => render(entry, vars));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        render(entry, vars),
      ])
    );
  }
  return value;
}
