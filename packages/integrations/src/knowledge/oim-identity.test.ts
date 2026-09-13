import { describe, expect, it } from "vitest";
import { resolveOimKnowledgePrincipals } from "./oim-identity";

describe("resolveOimKnowledgePrincipals", () => {
  it("passes the exact Connection tenant to trusted identity lookup", async () => {
    const lookups: unknown[] = [];
    const result = await resolveOimKnowledgePrincipals(
      {
        businessId: "business-1",
        integrationId: "wiki",
        integrationMajorVersion: 2,
        connectionId: "connection-1",
        externalTenantId: "tenant-b",
        externalAccountId: "account-b",
        entries: [{ kind: "user", id: "same-subject" }],
      },
      {
        links: {
          async linkedPrincipal(input) {
            lookups.push(input);
            return input.externalTenantId === "tenant-a"
              ? { kind: "user", id: "wrong-user" }
              : undefined;
          },
        },
        policy: { verifiedEmailDomains: [] },
      }
    );

    expect(result).toEqual({ principals: [], incomplete: false });
    expect(lookups).toEqual([
      {
        businessId: "business-1",
        provider: "wiki",
        integrationId: "wiki",
        integrationMajorVersion: 2,
        connectionId: "connection-1",
        externalTenantId: "tenant-b",
        providerId: "same-subject",
      },
    ]);
  });

  it("maps public and domain grants without treating them as user identities", async () => {
    const result = await resolveOimKnowledgePrincipals(
      {
        businessId: "business-1",
        integrationId: "wiki",
        integrationMajorVersion: 2,
        connectionId: "connection-1",
        externalTenantId: "tenant-1",
        externalAccountId: "account-1",
        entries: [{ kind: "public" }, { kind: "domain", id: "Example.COM" }],
      },
      {
        links: { async linkedPrincipal() {} },
        policy: { verifiedEmailDomains: [] },
      }
    );

    expect(result).toEqual({
      principals: [
        { kind: "role", id: "role-everyone" },
        { kind: "domain", id: "example.com" },
      ],
      incomplete: false,
    });
  });
});
