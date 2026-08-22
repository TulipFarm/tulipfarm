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

describe("jira bundled integration", () => {
  let manifest: IntegrationManifest;
  let spec: unknown;

  beforeAll(async () => {
    const dir = join(bundledIntegrationsDir(), "jira");
    manifest = parseYaml(await readFile(join(dir, "manifest.yml"), "utf8")) as IntegrationManifest;
    spec = parseYaml(await readFile(join(dir, "openapi.json"), "utf8"));
  });

  const integration = (): SoulIntegration =>
    ({
      slug: "jira",
      sourceIntegration: "jira",
      manifest,
      egressSpec: spec,
      connection: { enabled: true, env: { JIRA_CLOUD_ID: "cloud-123" } },
    }) as SoulIntegration;

  const build = () =>
    buildDeclarativeTools([integration()], {
      businessId: "biz",
      effects: new MemoryEffectStore(),
      secrets: async () => ({}) as SecretsService,
      http: { send: async () => ({ status: 200, headers: {}, body: {} }) },
    });

  it("uses the declarative Jira Cloud gateway path", () => {
    expect(manifest.egress?.type).toBe("openapi");
    expect(manifest.egress?.type === "openapi" && manifest.egress.base_url).toBe(
      "https://api.atlassian.com/ex/jira/{JIRA_CLOUD_ID}/rest/api/3"
    );
  });

  it("passes the same trust and connect-flow checks as a third-party manifest", () => {
    expect(validateThirdPartyManifest(manifest)).toEqual([]);
    expect(validateAuthSteps(manifest)).toEqual([]);
  });

  it("compiles the PM copilot Tool set with no problems", () => {
    const { tools, problems } = build();
    expect(problems).toEqual([]);
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "jira_create_issue",
      "jira_list_priorities",
      "jira_list_transitions",
      "jira_read_issue",
      "jira_search_issues",
      "jira_transition_issue",
      "jira_update_issue",
    ]);
  });

  it("gates Jira writes while keeping JQL search readable", () => {
    const mutating = Object.fromEntries(build().tools.map((tool) => [tool.name, tool.mutating]));
    expect(mutating.jira_search_issues).toBe(false);
    expect(mutating.jira_read_issue).toBe(false);
    expect(mutating.jira_list_priorities).toBe(false);
    expect(mutating.jira_list_transitions).toBe(false);
    expect(mutating.jira_create_issue).toBe(true);
    expect(mutating.jira_update_issue).toBe(true);
    expect(mutating.jira_transition_issue).toBe(true);
  });

  it("derives schemas that require a JQL query and an issue key", () => {
    const tools = new Map(build().tools.map((tool) => [tool.name, tool]));
    const search = tools.get("jira_search_issues")?.inputSchema as {
      properties: { body?: { required?: string[]; properties?: Record<string, unknown> } };
    };
    const read = tools.get("jira_read_issue")?.inputSchema as {
      required?: string[];
      properties?: Record<string, unknown>;
    };

    expect(search.properties.body?.required).toContain("jql");
    expect(search.properties.body?.properties).toHaveProperty("jql");
    expect(read.required).toContain("issueIdOrKey");
    expect(read.properties).toHaveProperty("issueIdOrKey");
  });
});
