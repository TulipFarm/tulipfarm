import { DEFAULT_ASSISTANT_NAME, type SoulAgent } from "@tulipfarm/soul";
import { InMemoryPrincipalRepo, InMemoryRoleRepo } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { ensureAgentPrincipal, reconcileAgentPrincipals } from "./agent-principals";
import { AGENT_ROLE_ID } from "./roles";

const BUSINESS = "business-1";
const NOW = new Date("2026-09-07T00:00:00.000Z");

function repos() {
  return { principals: new InMemoryPrincipalRepo(), roles: new InMemoryRoleRepo() };
}

function soulAgent(name: string): SoulAgent {
  return { name, frontmatter: {}, body: "" } as SoulAgent;
}

describe("ensureAgentPrincipal", () => {
  it("registers the Agent as an active principal holding the agent Role", async () => {
    const { principals, roles } = repos();

    await ensureAgentPrincipal({ principals, roles }, BUSINESS, "support");

    expect(await principals.get(BUSINESS, "support")).toEqual({
      id: "support",
      businessId: BUSINESS,
      kind: "agent",
      status: "active",
    });
    expect(await roles.listAssignments(BUSINESS, "support", NOW)).toEqual([
      { principalId: "support", roleId: AGENT_ROLE_ID, businessId: BUSINESS },
    ]);
  });

  it("is idempotent, so publication and the sweeps can all call it", async () => {
    const { principals, roles } = repos();

    await ensureAgentPrincipal({ principals, roles }, BUSINESS, "support");
    await ensureAgentPrincipal({ principals, roles }, BUSINESS, "support");

    expect(await roles.listAssignments(BUSINESS, "support", NOW)).toHaveLength(1);
  });
});

describe("reconcileAgentPrincipals", () => {
  it("provisions every Soul Agent and the built-in default assistant", async () => {
    const { principals, roles } = repos();
    const soul = {
      agents: new Map([
        ["support", soulAgent("support")],
        ["research", soulAgent("research")],
      ]),
    };

    await reconcileAgentPrincipals({ principals, roles }, soul, BUSINESS);

    expect((await principals.list(BUSINESS)).map((principal) => principal.id)).toEqual([
      DEFAULT_ASSISTANT_NAME,
      "research",
      "support",
    ]);
  });

  it("repairs an Agent that predates provisioning without touching the others", async () => {
    const { principals, roles } = repos();
    await ensureAgentPrincipal({ principals, roles }, BUSINESS, "support");
    const soul = {
      agents: new Map([
        ["support", soulAgent("support")],
        ["research", soulAgent("research")],
      ]),
    };

    await reconcileAgentPrincipals({ principals, roles }, soul, BUSINESS);

    expect(await roles.listAssignments(BUSINESS, "research", NOW)).toHaveLength(1);
    expect(await roles.listAssignments(BUSINESS, "support", NOW)).toHaveLength(1);
  });

  it("keeps going when one Agent cannot be provisioned", async () => {
    const { principals, roles } = repos();
    const warnings: string[] = [];
    const failing = {
      put: async (record: Parameters<InMemoryPrincipalRepo["put"]>[0]) => {
        if (record.id === "broken") throw new Error("principal rejected");
        await principals.put(record);
      },
    };
    const soul = {
      agents: new Map([
        ["broken", soulAgent("broken")],
        ["research", soulAgent("research")],
      ]),
    };

    await reconcileAgentPrincipals({ principals: failing, roles }, soul, BUSINESS, {
      warn: (message: string) => warnings.push(message),
    });

    expect(await principals.get(BUSINESS, "research")).toBeDefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("broken");
  });
});
