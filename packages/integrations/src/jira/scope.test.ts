import { ExternalIdentityDeniedError } from "@tulipfarm/authz";
import { describe, expect, it } from "vitest";
import {
  assertProjectInScope,
  JiraScopeDeniedError,
  type JiraSiteScope,
  jiraExternalSubject,
  parseIssueKey,
  resolveJiraActor,
} from "./scope";

const BUSINESS_ID = "biz-1";
const NOW = new Date("2026-07-25T00:00:00.000Z");

function scope(overrides: Partial<JiraSiteScope> = {}): JiraSiteScope {
  return {
    businessId: BUSINESS_ID,
    integrationId: "11111111-1111-4111-8111-111111111111",
    cloudId: "cloud-9",
    siteUrl: "https://tulip.atlassian.net",
    projects: ["FARM"],
    permissions: { issues: "write", users: "read" },
    ...overrides,
  };
}

describe("parseIssueKey", () => {
  it("splits a Jira issue key into project and number", () => {
    expect(parseIssueKey("FARM-12")).toEqual({ projectKey: "FARM", number: 12 });
  });

  it("rejects anything that is not a canonical issue key", () => {
    for (const bad of ["FARM", "farm-12", "FARM-", "-12", "FARM-12-3", ""]) {
      expect(() => parseIssueKey(bad)).toThrow(JiraScopeDeniedError);
    }
  });
});

describe("assertProjectInScope", () => {
  it("admits a project the site grant covers at the required level", () => {
    expect(() =>
      assertProjectInScope(scope(), "FARM", { permission: "issues", level: "write" })
    ).not.toThrow();
  });

  it("denies when no site installation was resolved", () => {
    expect(() =>
      assertProjectInScope(undefined, "FARM", { permission: "issues", level: "read" })
    ).toThrow(expect.objectContaining({ reason: "site_unknown" }));
  });

  it("denies a project outside the installation", () => {
    expect(() =>
      assertProjectInScope(scope(), "OTHER", { permission: "issues", level: "read" })
    ).toThrow(expect.objectContaining({ reason: "project_out_of_scope" }));
  });

  it("admits any project for a site-wide installation", () => {
    expect(() =>
      assertProjectInScope(scope({ projects: "all" }), "OTHER", {
        permission: "issues",
        level: "read",
      })
    ).not.toThrow();
  });

  it("denies a permission the installation never held", () => {
    expect(() =>
      assertProjectInScope(scope(), "FARM", { permission: "boards", level: "read" })
    ).toThrow(expect.objectContaining({ reason: "permission_missing" }));
  });

  it("does not let a read permission satisfy a write need", () => {
    expect(() =>
      assertProjectInScope(scope(), "FARM", { permission: "users", level: "write" })
    ).toThrow(expect.objectContaining({ reason: "permission_insufficient" }));
  });

  it("never repeats the target back in the denial message", () => {
    try {
      assertProjectInScope(scope(), "SECRETPROJ", { permission: "issues", level: "read" });
      expect.unreachable("expected denial");
    } catch (error) {
      expect((error as Error).message).not.toContain("SECRETPROJ");
    }
  });
});

describe("resolveJiraActor", () => {
  const mapping = {
    businessId: BUSINESS_ID,
    provider: "jira",
    externalSubject: jiraExternalSubject("acct-7"),
    principalId: "principal-1",
    verifiedAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  it("builds a provider-qualified external subject", () => {
    expect(jiraExternalSubject("acct-7")).toBe("jira:user:acct-7");
  });

  it("resolves a live verified mapping to its principal", () => {
    expect(resolveJiraActor(mapping, BUSINESS_ID, NOW)).toBe("principal-1");
  });

  it("refuses an unmapped Jira account rather than defaulting to an identity", () => {
    expect(() => resolveJiraActor(undefined, BUSINESS_ID, NOW)).toThrow(
      ExternalIdentityDeniedError
    );
  });

  it("refuses a mapping issued for another business", () => {
    expect(() => resolveJiraActor(mapping, "biz-2", NOW)).toThrow(ExternalIdentityDeniedError);
  });
});
