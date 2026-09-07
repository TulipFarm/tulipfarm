import { agentIdOf, DEFAULT_ASSISTANT_ID, type SoulAgent } from "@tulipfarm/soul";
import { InMemoryPrincipalRepo, InMemoryRoleRepo } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import {
  ensureAgentPrincipal,
  reconcileAgentPrincipals,
  removeAgentPrincipal,
} from "./agent-principals";
import { AGENT_ROLE_ID } from "./roles";

const BUSINESS = "business-1";
const NOW = new Date("2026-09-07T00:00:00.000Z");

function repos() {
  return { principals: new InMemoryPrincipalRepo(), roles: new InMemoryRoleRepo() };
}

function soulAgent(name: string): SoulAgent {
  return { id: agentIdOf(name, {}), name, frontmatter: {}, body: "" } as SoulAgent;
}

const SUPPORT = soulAgent("support");
const RESEARCH = soulAgent("research");

describe("ensureAgentPrincipal", () => {
  it("registers the Agent as an active principal holding the agent Role", async () => {
    const { principals, roles } = repos();

    await ensureAgentPrincipal({ principals, roles }, BUSINESS, SUPPORT.id);

    expect(await principals.get(BUSINESS, SUPPORT.id)).toEqual({
      id: SUPPORT.id,
      businessId: BUSINESS,
      kind: "agent",
      status: "active",
    });
    expect(await roles.listAssignments(BUSINESS, SUPPORT.id, NOW)).toEqual([
      { principalId: SUPPORT.id, roleId: AGENT_ROLE_ID, businessId: BUSINESS },
    ]);
  });

  it("is idempotent, so publication and the sweeps can all call it", async () => {
    const { principals, roles } = repos();

    await ensureAgentPrincipal({ principals, roles }, BUSINESS, SUPPORT.id);
    await ensureAgentPrincipal({ principals, roles }, BUSINESS, SUPPORT.id);

    expect(await roles.listAssignments(BUSINESS, SUPPORT.id, NOW)).toHaveLength(1);
  });
});

describe("removeAgentPrincipal", () => {
  it("retires the deleted Agent's principal so its authority outlives nothing", async () => {
    const { principals, roles } = repos();
    await ensureAgentPrincipal({ principals, roles }, BUSINESS, SUPPORT.id);

    await removeAgentPrincipal({ principals, roles }, BUSINESS, SUPPORT.id);

    expect(await principals.get(BUSINESS, SUPPORT.id)).toBeUndefined();
  });
});

describe("reconcileAgentPrincipals", () => {
  it("provisions every Soul Agent by its permanent id, and the built-in default assistant", async () => {
    const { principals, roles } = repos();
    const soul = {
      agents: new Map([
        ["support", SUPPORT],
        ["research", RESEARCH],
      ]),
    };

    await reconcileAgentPrincipals({ principals, roles }, soul, BUSINESS);

    expect(new Set((await principals.list(BUSINESS)).map((principal) => principal.id))).toEqual(
      new Set([DEFAULT_ASSISTANT_ID, RESEARCH.id, SUPPORT.id])
    );
  });

  it("repairs an Agent that predates provisioning without touching the others", async () => {
    const { principals, roles } = repos();
    await ensureAgentPrincipal({ principals, roles }, BUSINESS, SUPPORT.id);
    const soul = {
      agents: new Map([
        ["support", SUPPORT],
        ["research", RESEARCH],
      ]),
    };

    await reconcileAgentPrincipals({ principals, roles }, soul, BUSINESS);

    expect(await roles.listAssignments(BUSINESS, RESEARCH.id, NOW)).toHaveLength(1);
    expect(await roles.listAssignments(BUSINESS, SUPPORT.id, NOW)).toHaveLength(1);
  });

  it("keeps going when one Agent cannot be provisioned", async () => {
    const { principals, roles } = repos();
    const warnings: string[] = [];
    const broken = soulAgent("broken");
    const failing = {
      put: async (record: Parameters<InMemoryPrincipalRepo["put"]>[0]) => {
        if (record.id === broken.id) throw new Error("principal rejected");
        await principals.put(record);
      },
      delete: (businessId: string, id: string) => principals.delete(businessId, id),
    };
    const soul = {
      agents: new Map([
        ["broken", broken],
        ["research", RESEARCH],
      ]),
    };

    await reconcileAgentPrincipals({ principals: failing, roles }, soul, BUSINESS, {
      warn: (message: string) => warnings.push(message),
    });

    expect(await principals.get(BUSINESS, RESEARCH.id)).toBeDefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(broken.id);
  });
});
