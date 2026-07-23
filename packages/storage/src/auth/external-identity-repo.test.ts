import { describe, expect, it } from "vitest";
import {
  type ExternalIdentityMappingRecord,
  InMemoryExternalIdentityRepo,
} from "./external-identity-repo";

function mapping(
  overrides: Partial<ExternalIdentityMappingRecord> = {}
): ExternalIdentityMappingRecord {
  return {
    businessId: "business-1",
    provider: "slack",
    externalSubject: "U123",
    principalId: "principal-1",
    verifiedAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

describe("InMemoryExternalIdentityRepo", () => {
  it("round-trips a mapping by business/provider/subject", async () => {
    const repo = new InMemoryExternalIdentityRepo();
    await repo.put(mapping());
    await expect(repo.find("business-1", "slack", "U123")).resolves.toEqual(mapping());
  });

  it("returns undefined for an unknown mapping", async () => {
    const repo = new InMemoryExternalIdentityRepo();
    await expect(repo.find("business-1", "slack", "missing")).resolves.toBeUndefined();
  });

  it("scopes mappings per business even for the same provider/subject", async () => {
    const repo = new InMemoryExternalIdentityRepo();
    await repo.put(mapping({ businessId: "business-1", principalId: "principal-1" }));
    await repo.put(mapping({ businessId: "business-2", principalId: "principal-2" }));
    await expect(repo.find("business-1", "slack", "U123")).resolves.toMatchObject({
      principalId: "principal-1",
    });
    await expect(repo.find("business-2", "slack", "U123")).resolves.toMatchObject({
      principalId: "principal-2",
    });
  });
});
