import { describe, expect, it } from "vitest";
import { checkOimProviderAccess } from "./oim-live-authorization";
import type { KnowledgeProfilePlan } from "./oim-profile";

const connection = {
  businessId: "business-1",
  integrationId: "wiki",
  integrationMajorVersion: 2,
  connectionId: "connection-1",
  externalTenantId: "tenant-1",
  externalAccountId: "account-1",
};

const source = {
  businessId: "business-1",
  itemId: "page-1",
  connectionId: "connection-1",
  externalTenantId: "tenant-1",
  externalAccountId: "account-1",
  fields: {},
};

function plan(): KnowledgeProfilePlan {
  const operation: KnowledgeProfilePlan["list"]["operation"] = {
    id: "check-access",
    name: "check_access",
    description: "Check access.",
    effect: "sensitive_read",
    identityMode: "shared_only",
    source: {
      type: "http",
      method: "GET",
      baseUrl: "https://wiki.example",
      path: "/access",
      parameters: [],
    },
    response: { schema: { type: "object" }, maxBytes: 1_048_576 },
  };
  return {
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
      itemParameter: "id",
      mapping: { content: "/content" },
      sensitive: true,
    },
    acl: {
      mode: "item",
      operation,
      parameter: "id",
      entriesPointer: "/readers",
      entry: { defaultKind: "user", providerUserId: "/id" },
    },
    deletion: { kind: "absent_from_full_list" },
    liveAuthorization: {
      operation,
      itemParameter: "id",
      principalSet: { entriesPointer: "/members", principalIdPointer: "/id" },
    },
  };
}

describe("checkOimProviderAccess", () => {
  it("fails closed when a principal-set pointer is missing or nonarray", async () => {
    await expect(
      checkOimProviderAccess(
        plan(),
        {
          connection,
          async execute() {
            return { body: {} };
          },
        },
        source,
        "subject-1"
      )
    ).resolves.toBeUndefined();
  });

  it("walks bounded provider pages until the exact subject is found", async () => {
    let calls = 0;
    await expect(
      checkOimProviderAccess(
        plan(),
        {
          connection,
          async execute({ pageToken }) {
            calls += 1;
            return pageToken === undefined
              ? { body: { members: [{ id: "other" }] }, nextPageToken: "page-2" }
              : { body: { members: [{ id: "subject-1" }] } };
          },
        },
        source,
        "subject-1"
      )
    ).resolves.toBe(true);
    expect(calls).toBe(2);
  });

  it("does not call a provider client bound to another tenant", async () => {
    let calls = 0;
    await expect(
      checkOimProviderAccess(
        plan(),
        {
          connection: { ...connection, externalTenantId: "tenant-2" },
          async execute() {
            calls += 1;
            return { body: { members: [{ id: "subject-1" }] } };
          },
        },
        source,
        "subject-1"
      )
    ).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });
});
