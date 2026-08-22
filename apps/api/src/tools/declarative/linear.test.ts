import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SecretsService } from "@tulipfarm/secrets";
import type { IntegrationManifest, SoulIntegration } from "@tulipfarm/soul";
import {
  bundledIntegrationsDir,
  validateAuthSteps,
  validateThirdPartyManifest,
} from "@tulipfarm/soul";
import { MemoryEffectStore } from "@tulipfarm/tool-broker";
import { beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildDeclarativeTools } from "./tools";

describe("linear bundled integration", () => {
  let manifest: IntegrationManifest;

  beforeAll(async () => {
    const dir = join(bundledIntegrationsDir(), "linear");
    manifest = parseYaml(await readFile(join(dir, "manifest.yml"), "utf8")) as IntegrationManifest;
  });

  const integration = (): SoulIntegration =>
    ({
      slug: "linear",
      sourceIntegration: "linear",
      manifest,
      connection: { enabled: true, env: {} },
    }) as SoulIntegration;

  const build = () =>
    buildDeclarativeTools([integration()], {
      businessId: "biz",
      effects: new MemoryEffectStore(),
      secrets: async () => ({}) as SecretsService,
      http: { send: async () => ({ status: 200, headers: {}, body: { data: {} } }) },
    });

  it("passes the same trust and connect-flow checks as a third-party manifest", () => {
    expect(validateThirdPartyManifest(manifest)).toEqual([]);
    expect(validateAuthSteps(manifest)).toEqual([]);
  });

  it("publishes fixed GraphQL tools without accepting a raw query argument", () => {
    const { tools, problems } = build();
    expect(problems).toEqual([]);
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "linear_create_comment",
      "linear_create_issue",
      "linear_list_issues",
      "linear_list_teams",
      "linear_read_issue",
      "linear_update_issue",
    ]);
    expect(
      tools.every((tool) => {
        const schema = tool.inputSchema as { properties: Record<string, unknown> };
        return !("query" in schema.properties);
      })
    ).toBe(true);
  });

  it("gates GraphQL mutations while keeping GraphQL queries readable", () => {
    const mutating = Object.fromEntries(build().tools.map((tool) => [tool.name, tool.mutating]));
    expect(mutating.linear_list_teams).toBe(false);
    expect(mutating.linear_list_issues).toBe(false);
    expect(mutating.linear_read_issue).toBe(false);
    expect(mutating.linear_create_issue).toBe(true);
    expect(mutating.linear_update_issue).toBe(true);
    expect(mutating.linear_create_comment).toBe(true);
  });

  it("requires only declared variables for a Linear mutation", () => {
    const create = build().tools.find((tool) => tool.name === "linear_create_issue");
    expect(create?.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["teamId", "title"],
      properties: { teamId: { type: "string" }, title: { type: "string" } },
    });
  });
});
