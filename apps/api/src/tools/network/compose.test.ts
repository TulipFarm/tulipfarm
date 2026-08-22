import type { AuthorityLayer } from "@tulipfarm/authz";
import type { LlmService } from "@tulipfarm/llm";
import type { SecretsService } from "@tulipfarm/secrets";
import type { SoulLoader } from "@tulipfarm/soul";
import { describe, expect, it, vi } from "vitest";
import { composeNetworkTools } from "./compose";

function tools(frontmatter: Record<string, unknown>, grants: AuthorityLayer["grants"]) {
  const send = vi.fn(async () => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: { ok: true },
  }));
  const composed = composeNetworkTools({
    secrets: { get: vi.fn(async () => "token-value") } as unknown as SecretsService,
    soulLoader: {
      skills: new Map([["jira", { name: "jira", body: "Use Jira.", frontmatter }]]),
    } as unknown as SoulLoader,
    authorityLayers: {
      resolvePrincipalLayer: vi.fn(async () => ({ name: "user", grants })),
    },
    llm: {} as LlmService,
    http: { send },
    extract: vi.fn(async () => "extracted"),
  });
  const apiRequest = composed.find((tool) => tool.name === "api_request");
  if (apiRequest === undefined) throw new Error("api_request was not composed");
  return { apiRequest, send };
}

const args = {
  url: "https://api.atlassian.com/me",
  method: "GET",
  credential: { secret: "JIRA_API_TOKEN", header: "authorization" },
};

describe("network Skill Secret authority", () => {
  it("intersects the Skill declaration with the caller's exact secret.use grant", async () => {
    const { apiRequest, send } = tools(
      {
        requiredSecrets: ["JIRA_API_TOKEN"],
        allowedDomains: ["api.atlassian.com"],
      },
      [
        {
          action: "secret.use",
          resourceType: "secret",
          recordSelector: "JIRA_API_TOKEN",
          destination: "https://api.atlassian.com",
          effect: "allow",
        },
      ]
    );
    const result = await apiRequest.execute(args, {
      userId: "user-1",
      runId: "run-1",
      activeSkillName: "jira",
    });
    expect(result).toMatchObject({ success: true });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { authorization: "Bearer token-value" } })
    );
  });

  it("denies a guessed Secret that the active Skill did not declare", async () => {
    const { apiRequest, send } = tools(
      { requiredSecrets: ["OTHER_TOKEN"], allowedDomains: ["api.atlassian.com"] },
      [{ action: "*", resourceType: "*", effect: "allow" }]
    );
    const result = await apiRequest.execute(args, {
      userId: "user-1",
      runId: "run-1",
      activeSkillName: "jira",
    });
    expect(result).toMatchObject({ success: false, error: { code: "write_denied" } });
    expect(send).not.toHaveBeenCalled();
  });

  it("denies a caller without the exact secret.use grant", async () => {
    const { apiRequest, send } = tools(
      {
        requiredSecrets: ["JIRA_API_TOKEN"],
        allowedDomains: ["api.atlassian.com"],
      },
      []
    );
    const result = await apiRequest.execute(args, {
      userId: "user-1",
      runId: "run-1",
      activeSkillName: "jira",
    });
    expect(result).toMatchObject({ success: false, error: { code: "write_denied" } });
    expect(send).not.toHaveBeenCalled();
  });
});
