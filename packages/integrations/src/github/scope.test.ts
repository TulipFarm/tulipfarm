import { ExternalIdentityDeniedError } from "@tulipfarm/authz";
import { describe, expect, it } from "vitest";
import {
  assertRepositoryInScope,
  type GitHubInstallationScope,
  GitHubScopeDeniedError,
  githubExternalSubject,
  parseRepositoryRef,
  resolveGitHubActor,
} from "./scope";

const BUSINESS_ID = "biz-1";
const NOW = new Date("2026-07-25T00:00:00.000Z");

function scope(overrides: Partial<GitHubInstallationScope> = {}): GitHubInstallationScope {
  return {
    businessId: BUSINESS_ID,
    integrationId: "11111111-1111-4111-8111-111111111111",
    installationId: "inst-9",
    accountLogin: "tulip",
    repositories: ["tulip/farm"],
    permissions: { issues: "write", metadata: "read" },
    ...overrides,
  };
}

describe("parseRepositoryRef", () => {
  it("splits owner/repo", () => {
    expect(parseRepositoryRef("tulip/farm")).toEqual({ owner: "tulip", repo: "farm" });
  });

  it("rejects a ref that is not exactly owner/repo", () => {
    for (const bad of ["farm", "tulip/farm/extra", "/farm", "tulip/", ""]) {
      expect(() => parseRepositoryRef(bad)).toThrow(GitHubScopeDeniedError);
    }
  });
});

describe("assertRepositoryInScope", () => {
  const target = { owner: "tulip", repo: "farm" };

  it("admits a repository the installation covers with sufficient permission", () => {
    expect(() =>
      assertRepositoryInScope(scope(), target, { permission: "issues", level: "write" })
    ).not.toThrow();
  });

  it("denies when no installation was resolved at all", () => {
    expect(() =>
      assertRepositoryInScope(undefined, target, { permission: "issues", level: "read" })
    ).toThrow(expect.objectContaining({ reason: "installation_unknown" }));
  });

  it("denies a repository the installation was never granted", () => {
    expect(() =>
      assertRepositoryInScope(scope({ repositories: ["tulip/other"] }), target, {
        permission: "issues",
        level: "read",
      })
    ).toThrow(expect.objectContaining({ reason: "repository_out_of_scope" }));
  });

  it("denies a repository owned by another account even when the name matches", () => {
    expect(() =>
      assertRepositoryInScope(
        scope({ repositories: "all" }),
        { owner: "evil", repo: "farm" },
        {
          permission: "issues",
          level: "read",
        }
      )
    ).toThrow(expect.objectContaining({ reason: "account_out_of_scope" }));
  });

  it("admits any repository under the account for an all-repositories installation", () => {
    expect(() =>
      assertRepositoryInScope(
        scope({ repositories: "all" }),
        { owner: "tulip", repo: "anything" },
        {
          permission: "issues",
          level: "read",
        }
      )
    ).not.toThrow();
  });

  it("denies a permission the installation does not hold", () => {
    expect(() =>
      assertRepositoryInScope(scope(), target, { permission: "contents", level: "read" })
    ).toThrow(expect.objectContaining({ reason: "permission_missing" }));
  });

  it("does not let a read permission satisfy a write need", () => {
    expect(() =>
      assertRepositoryInScope(scope({ permissions: { issues: "read" } }), target, {
        permission: "issues",
        level: "write",
      })
    ).toThrow(expect.objectContaining({ reason: "permission_insufficient" }));
  });
});

describe("resolveGitHubActor", () => {
  const mapping = {
    businessId: BUSINESS_ID,
    provider: "github",
    externalSubject: githubExternalSubject("4242"),
    principalId: "principal-1",
    verifiedAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  it("builds a provider-qualified external subject", () => {
    expect(githubExternalSubject("4242")).toBe("github:user:4242");
  });

  it("resolves a live verified mapping to its principal", () => {
    expect(resolveGitHubActor(mapping, BUSINESS_ID, NOW)).toBe("principal-1");
  });

  it("refuses an unmapped external actor rather than defaulting to an identity", () => {
    expect(() => resolveGitHubActor(undefined, BUSINESS_ID, NOW)).toThrow(
      ExternalIdentityDeniedError
    );
  });

  it("refuses a mapping belonging to another business", () => {
    expect(() => resolveGitHubActor(mapping, "biz-2", NOW)).toThrow(ExternalIdentityDeniedError);
  });

  it("refuses an expired mapping", () => {
    const expired = { ...mapping, expiresAt: new Date("2026-07-24T00:00:00.000Z") };
    expect(() => resolveGitHubActor(expired, BUSINESS_ID, NOW)).toThrow(
      ExternalIdentityDeniedError
    );
  });
});
