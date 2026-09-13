import { describe, expect, it } from "vitest";
import { createOimProviderAccountPort } from "./oim-accounts";
import type { KnowledgeProfilePlan } from "./oim-profile";
import type { OimKnowledgeApiPort, OimKnowledgeExecutionScope } from "./oim-sync";

const connection: OimKnowledgeExecutionScope = {
  businessId: "business-1",
  integrationId: "wiki",
  integrationMajorVersion: 2,
  connectionId: "connection-1",
  externalTenantId: "tenant-1",
  externalAccountId: "account-1",
};

const operation: KnowledgeProfilePlan["list"]["operation"] = {
  id: "get-user",
  name: "get_user",
  description: "Get a provider user.",
  effect: "read",
  identityMode: "shared_only",
  source: {
    type: "http",
    method: "GET",
    baseUrl: "https://wiki.example",
    path: "/users",
    parameters: [],
  },
  response: { schema: { type: "object" }, maxBytes: 1_048_576 },
};

const plan: KnowledgeProfilePlan = {
  integrationId: "wiki",
  integrationVersion: "2.1.0",
  majorVersion: 2,
  sourceKinds: [],
  list: {
    operation,
    itemsPointer: "/items",
    mapping: { itemId: "/id" },
    cursor: { kind: "none" },
    maxPagesPerRun: 1,
  },
  content: {
    operation,
    mapping: { content: "/content" },
    sensitive: false,
  },
  acl: {
    mode: "item",
    operation,
    entriesPointer: "/readers",
    entry: { defaultKind: "user", providerUserId: "/id" },
  },
  identity: {
    user: {
      operation,
      idParameter: "user",
      mapping: { providerId: "/id", email: "/email", emailVerified: "/verified" },
    },
    group: {
      operation,
      idParameter: "group",
      membersPointer: "/members",
      mapping: { providerId: "/id", memberUserId: "/userId" },
    },
  },
  deletion: { kind: "none" },
};

function input(overrides: Partial<OimKnowledgeExecutionScope> = {}) {
  return { ...connection, providerId: "provider-user-1", ...overrides };
}

describe("createOimProviderAccountPort", () => {
  it("reads verified account data through the exact bound Connection", async () => {
    const api: OimKnowledgeApiPort = {
      connection,
      async execute(request) {
        expect(request.parameters).toEqual({ user: "provider-user-1" });
        return {
          body: { id: "provider-user-1", email: "muskan@example.com", verified: true },
        };
      },
    };

    await expect(createOimProviderAccountPort(plan, api).account(input())).resolves.toEqual({
      email: "muskan@example.com",
      emailVerified: true,
    });
  });

  it("does not call a provider client bound to another tenant", async () => {
    let calls = 0;
    const api: OimKnowledgeApiPort = {
      connection,
      async execute() {
        calls += 1;
        return { body: {} };
      },
    };

    await expect(
      createOimProviderAccountPort(plan, api).account(input({ externalTenantId: "tenant-2" }))
    ).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });

  it("rejects account data returned for another provider subject", async () => {
    const api: OimKnowledgeApiPort = {
      connection,
      async execute() {
        return {
          body: { id: "provider-user-2", email: "muskan@example.com", verified: true },
        };
      },
    };

    await expect(createOimProviderAccountPort(plan, api).account(input())).resolves.toBeUndefined();
  });

  it("reads members only from the exact provider group", async () => {
    const api: OimKnowledgeApiPort = {
      connection,
      async execute(request) {
        expect(request.parameters).toEqual({ group: "provider-group-1" });
        return {
          body: {
            id: "provider-group-1",
            members: [{ userId: "provider-user-1" }, { userId: 2 }],
          },
        };
      },
    };

    await expect(
      createOimProviderAccountPort(plan, api).groupMembers({
        ...connection,
        groupId: "provider-group-1",
      })
    ).resolves.toEqual(["provider-user-1", "2"]);
  });

  it("rejects members returned for another provider group", async () => {
    const api: OimKnowledgeApiPort = {
      connection,
      async execute() {
        return {
          body: { id: "provider-group-2", members: [{ userId: "provider-user-1" }] },
        };
      },
    };

    await expect(
      createOimProviderAccountPort(plan, api).groupMembers({
        ...connection,
        groupId: "provider-group-1",
      })
    ).resolves.toBeUndefined();
  });
});
