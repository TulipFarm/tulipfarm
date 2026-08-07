import type { IntegrationStore } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { GITHUB_TOOL_NAMES } from "./tools";
import { githubDisabledSkillNames, githubExcludedToolNames } from "./visibility";

class FakeIntegrationStore {
  constructor(private readonly status: string | undefined) {}
  async loadProviderSnapshot() {
    return {
      apps: [],
      integrations: this.status ? [{ id: "github-1", status: this.status }] : [],
      accessGrants: [],
      routes: [],
    };
  }
}

describe("githubExcludedToolNames", () => {
  it("excludes every GitHub tool name when no active install exists", async () => {
    const excluded = await githubExcludedToolNames({
      integrations: new FakeIntegrationStore(undefined) as unknown as IntegrationStore,
      businessId: "biz-1",
    });
    expect(excluded).toEqual(GITHUB_TOOL_NAMES);
  });

  it("excludes every GitHub tool name when the install is not active", async () => {
    const excluded = await githubExcludedToolNames({
      integrations: new FakeIntegrationStore("revoked") as unknown as IntegrationStore,
      businessId: "biz-1",
    });
    expect(excluded).toEqual(GITHUB_TOOL_NAMES);
  });

  it("excludes nothing once GitHub is actively installed", async () => {
    const excluded = await githubExcludedToolNames({
      integrations: new FakeIntegrationStore("active") as unknown as IntegrationStore,
      businessId: "biz-1",
    });
    expect(excluded).toEqual(new Set());
  });
});

describe("githubDisabledSkillNames", () => {
  it("disables the github skill when no active install exists", async () => {
    const disabled = await githubDisabledSkillNames({
      integrations: new FakeIntegrationStore(undefined) as unknown as IntegrationStore,
      businessId: "biz-1",
    });
    expect(disabled).toEqual(new Set(["github"]));
  });

  it("leaves the github skill enabled once GitHub is actively installed", async () => {
    const disabled = await githubDisabledSkillNames({
      integrations: new FakeIntegrationStore("active") as unknown as IntegrationStore,
      businessId: "biz-1",
    });
    expect(disabled).toEqual(new Set());
  });
});
