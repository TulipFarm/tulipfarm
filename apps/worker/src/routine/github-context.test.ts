import type { ToolIntent } from "@tulipfarm/tool-broker";
import { describe, expect, it } from "vitest";
import { InstallationScopeGitHubContextResolver } from "./github-context";
import type { GitHubInstallationDirectory, GitHubInstallationRecord } from "./github-installation";

const BUSINESS_ID = "biz-1";

const INSTALLATION: GitHubInstallationRecord = {
  integrationId: "integration-1",
  installationId: "install-1",
  accountLogin: "tulip",
  appExternalId: "123456",
  repositories: ["tulip/farm"],
  permissions: { issues: "write", metadata: "read" },
};

function directoryOf(records: readonly GitHubInstallationRecord[]): GitHubInstallationDirectory {
  return { list: async () => records };
}

function intentFor(args: Record<string, unknown>): ToolIntent {
  return {
    intentId: "intent-1",
    businessId: BUSINESS_ID,
    runId: "run-1",
    stateId: "state-1",
    toolId: "github.issue.read",
    toolVersion: "1",
    action: "github.issue.read",
    targetRefs: [],
    arguments: args,
    idempotencyKey: "idem-1",
  };
}

describe("InstallationScopeGitHubContextResolver", () => {
  it("resolves the installation covering the intent's repository", async () => {
    const resolver = new InstallationScopeGitHubContextResolver(
      BUSINESS_ID,
      directoryOf([INSTALLATION])
    );
    const context = await resolver.resolve(intentFor({ repository: "tulip/farm" }));
    expect(context?.integrationId).toBe("integration-1");
    expect(context?.installation.repositories).toEqual(["tulip/farm"]);
    expect(context?.grants).toHaveLength(1);
    expect(context?.grants[0]?.spec.externalTargets).toEqual([
      { type: "github.repository", ids: ["tulip/farm"] },
    ]);
    expect(context?.principals).toEqual([{ kind: "role", id: expect.any(String) }]);
  });

  it("returns undefined when no installation covers the repository", async () => {
    const resolver = new InstallationScopeGitHubContextResolver(
      BUSINESS_ID,
      directoryOf([INSTALLATION])
    );
    const context = await resolver.resolve(intentFor({ repository: "other/repo" }));
    expect(context).toBeUndefined();
  });

  it("returns undefined when the intent names no repository", async () => {
    const resolver = new InstallationScopeGitHubContextResolver(
      BUSINESS_ID,
      directoryOf([INSTALLATION])
    );
    expect(await resolver.resolve(intentFor({}))).toBeUndefined();
  });

  it("resolves a repository-create intent by account, not by repository", async () => {
    const resolver = new InstallationScopeGitHubContextResolver(
      BUSINESS_ID,
      directoryOf([INSTALLATION])
    );
    const intent: ToolIntent = {
      ...intentFor({ owner: "tulip", name: "new-repo" }),
      toolId: "github.repository.create",
      action: "github.repository.create",
    };
    const context = await resolver.resolve(intent);
    expect(context?.integrationId).toBe("integration-1");
    expect(context?.grants[0]?.spec.externalTargets).toEqual([
      { type: "github.organization", ids: ["tulip"] },
    ]);
  });

  it("returns undefined for a repository-create intent when no installation covers the owner", async () => {
    const resolver = new InstallationScopeGitHubContextResolver(
      BUSINESS_ID,
      directoryOf([INSTALLATION])
    );
    const intent: ToolIntent = {
      ...intentFor({ owner: "other-org", name: "new-repo" }),
      toolId: "github.repository.create",
      action: "github.repository.create",
    };
    expect(await resolver.resolve(intent)).toBeUndefined();
  });
});
