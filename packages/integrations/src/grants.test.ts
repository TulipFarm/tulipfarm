import type { AccessGrantDefinition } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import {
  assertIntegrationAccess,
  decideIntegrationAccess,
  IntegrationAccessDeniedError,
} from "./grants";

const INTEGRATION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_INTEGRATION_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-07-25T00:00:00.000Z");

function grant(
  overrides: Partial<AccessGrantDefinition["spec"]> = {},
  id = "44444444-4444-4444-8444-444444444444"
): AccessGrantDefinition {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "AccessGrant",
    metadata: {
      id,
      slug: "triage-grant",
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "active",
    },
    spec: {
      integrationId: INTEGRATION_ID,
      principals: [{ kind: "agent", id: AGENT_ID }],
      actions: ["github.issue.read", "github.issue.comment"],
      externalTargets: [{ type: "github-repository", ids: ["tulip/farm"] }],
      delegable: false,
      ...overrides,
    },
  };
}

const request = {
  integrationId: INTEGRATION_ID,
  principals: [{ kind: "agent", id: AGENT_ID }] as const,
  action: "github.issue.read",
  target: { type: "github-repository", id: "tulip/farm" },
};

describe("decideIntegrationAccess", () => {
  it("allows a matching grant and names the grant that authorized it", () => {
    expect(decideIntegrationAccess([grant()], request, NOW)).toEqual({
      allowed: true,
      grantId: "44444444-4444-4444-8444-444444444444",
    });
  });

  it("denies by default when no grant exists", () => {
    expect(decideIntegrationAccess([], request, NOW)).toEqual({
      allowed: false,
      reason: "no_grant",
    });
  });

  it("denies a grant issued for a different Integration", () => {
    const decision = decideIntegrationAccess(
      [grant({ integrationId: OTHER_INTEGRATION_ID })],
      request,
      NOW
    );
    expect(decision).toEqual({ allowed: false, reason: "integration_mismatch" });
  });

  it("denies an action the grant never listed — a read grant is not a write grant", () => {
    expect(
      decideIntegrationAccess([grant()], { ...request, action: "github.issue.close" }, NOW)
    ).toEqual({ allowed: false, reason: "action_not_granted" });
  });

  it("denies a repository outside the grant's external targets", () => {
    expect(
      decideIntegrationAccess(
        [grant()],
        { ...request, target: { type: "github-repository", id: "other/repo" } },
        NOW
      )
    ).toEqual({ allowed: false, reason: "target_not_granted" });
  });

  it("denies a principal the grant never named", () => {
    expect(
      decideIntegrationAccess(
        [grant()],
        { ...request, principals: [{ kind: "user", id: AGENT_ID }] },
        NOW
      )
    ).toEqual({ allowed: false, reason: "principal_not_granted" });
  });

  it("stops honouring an expired grant", () => {
    const expired = grant({ expiresAt: "2026-07-24T00:00:00.000Z" });
    expect(decideIntegrationAccess([expired], request, NOW)).toEqual({
      allowed: false,
      reason: "grant_expired",
    });
  });

  it("does not let a wildcard action slip past the closed action list", () => {
    expect(
      decideIntegrationAccess([grant({ actions: ["github.issue.read"] })], request, NOW)
    ).toEqual({ allowed: true, grantId: "44444444-4444-4444-8444-444444444444" });
    expect(
      decideIntegrationAccess(
        [grant({ actions: ["github.issue.read"] })],
        { ...request, action: "github.issue.comment" },
        NOW
      )
    ).toEqual({ allowed: false, reason: "action_not_granted" });
  });

  it("prefers an allowing grant when several are present", () => {
    const narrow = grant(
      { actions: ["github.issue.close"] },
      "55555555-5555-4555-8555-555555555555"
    );
    expect(decideIntegrationAccess([narrow, grant()], request, NOW)).toMatchObject({
      allowed: true,
    });
  });
});

describe("assertIntegrationAccess", () => {
  it("throws a reason-carrying denial that never echoes the target", () => {
    try {
      assertIntegrationAccess([], request, NOW);
      expect.unreachable("expected denial");
    } catch (error) {
      expect(error).toBeInstanceOf(IntegrationAccessDeniedError);
      expect((error as IntegrationAccessDeniedError).reason).toBe("no_grant");
      expect((error as Error).message).not.toContain("tulip/farm");
    }
  });

  it("returns the authorizing grant id when access is allowed", () => {
    expect(assertIntegrationAccess([grant()], request, NOW)).toBe(
      "44444444-4444-4444-8444-444444444444"
    );
  });
});
