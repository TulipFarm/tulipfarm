import type { ProductTelemetryState } from "@tulipfarm/observability";
import type { Queryable } from "@tulipfarm/storage";
import { expect, it, vi } from "vitest";
import { composeProductTelemetry, type TelemetryComposition } from "./compose";

vi.mock("../../setup/soul-config", () => ({
  readSoulConfig: async () => ({
    setupComplete: true,
    businessName: "Muskan\nVijayvargiya",
    businessWebsite: "https://user:secret@example.com/site?token=private#fragment",
  }),
}));
vi.mock("../../integrations/github-status", () => ({ isGitHubInstalled: async () => true }));
class Database implements Queryable {
  state: ProductTelemetryState | undefined;
  async query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
    let rows: unknown[] = [];
    if (sql.startsWith("INSERT INTO deployment_product_telemetry"))
      this.state ??= JSON.parse(String(params?.[0]));
    else if (sql.startsWith("UPDATE deployment_product_telemetry"))
      this.state = JSON.parse(String(params?.[0]));
    else if (sql.startsWith("SELECT state")) rows = [{ state: structuredClone(this.state) }];
    else if (sql.includes("FROM connections")) rows = [{ integration_id: "crm" }];
    return { rows: rows as Row[] };
  }
}
it("collects configured inventory, deduplicates providers and excludes bundled Skill names", async () => {
  const database = new Database();
  const deps = {
    database,
    transactions: { withTransaction: async <T>(fn: (q: Queryable) => Promise<T>) => fn(database) },
    businessId: "business",
    soulPath: "unused",
    soulRepositoryUrl: () => "https://user:secret@git.example.com/repo?token=private",
    userRepo: { count: async () => 3 },
    integrations: {},
    publicOrigins: {
      current: () => ({ webOrigin: "https://instance.example.com/private?token=hidden" }),
    },
    bundledSkillNames: () => new Set(["bundled"]),
    soulLoader: {
      skills: new Map([
        ["bundled", {}],
        ["custom", {}],
      ]),
      resources: new Map([["Customer", {}]]),
      agents: new Map([["Support", {}]]),
      routines: new Map([["Follow up", {}]]),
      integrations: new Map([
        ["catalog-only", {}],
        ["slack", { connection: { enabled: true } }],
        ["crm", { connection: { enabled: true } }],
      ]),
    },
  } as unknown as TelemetryComposition;
  const reporter = composeProductTelemetry(deps);
  await reporter.initialize();
  const status = await reporter.status();
  expect(status.preview.snapshot?.data).toEqual({
    users: 3,
    resource_types: 1,
    integrations: 3,
    skills: 1,
    bundled_skills: 1,
    agents: 1,
    routines: 1,
    resource_type_names: ["Customer"],
    integration_providers: ["crm", "github", "slack"],
    skill_names: ["custom"],
    agent_names: ["Support"],
  });
  expect(status.preview.bootstrap?.data).toMatchObject({
    business_name: "Muskan Vijayvargiya",
    business_website: "https://example.com/site",
    instance_url: "https://instance.example.com",
    soul_repository_url: "https://git.example.com/repo",
  });
  expect(JSON.stringify(status)).not.toContain("secret");
  expect(JSON.stringify(status)).not.toContain("token=");
});
