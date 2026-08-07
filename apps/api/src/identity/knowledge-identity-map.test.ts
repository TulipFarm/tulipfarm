import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { describe, expect, it } from "vitest";
import { MemoryExternalIdentityRepo } from "./fakes";
import { ExternalLinkKnowledgeIdentityMap } from "./knowledge-identity-map";

describe("ExternalLinkKnowledgeIdentityMap", () => {
  it("resolves a mapped Slack subject to its Tulip user principal", async () => {
    const repo = new MemoryExternalIdentityRepo();
    repo.mappings.push({
      provider: "slack",
      externalSubject: "U123",
      userId: "u1",
      verifiedAt: new Date(),
      expiresAt: null,
    });
    const map = new ExternalLinkKnowledgeIdentityMap(repo);

    const principals = await map.resolve({
      businessId: DEPLOYMENT_BUSINESS_ID,
      provider: "slack",
      externalSubject: "U123",
    });

    expect(principals).toEqual([{ kind: "user", id: "u1" }]);
  });

  it("returns undefined for an unmapped subject rather than an implicit grant", async () => {
    const repo = new MemoryExternalIdentityRepo();
    const map = new ExternalLinkKnowledgeIdentityMap(repo);

    const principals = await map.resolve({
      businessId: DEPLOYMENT_BUSINESS_ID,
      provider: "slack",
      externalSubject: "U-unknown",
    });

    expect(principals).toBeUndefined();
  });

  it("returns undefined for an expired mapping", async () => {
    const repo = new MemoryExternalIdentityRepo();
    repo.mappings.push({
      provider: "slack",
      externalSubject: "U123",
      userId: "u1",
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() - 1000),
    });
    const map = new ExternalLinkKnowledgeIdentityMap(repo);

    const principals = await map.resolve({
      businessId: DEPLOYMENT_BUSINESS_ID,
      provider: "slack",
      externalSubject: "U123",
    });

    expect(principals).toBeUndefined();
  });

  it("returns undefined when the businessId does not match this deployment", async () => {
    const repo = new MemoryExternalIdentityRepo();
    repo.mappings.push({
      provider: "slack",
      externalSubject: "U123",
      userId: "u1",
      verifiedAt: new Date(),
      expiresAt: null,
    });
    const map = new ExternalLinkKnowledgeIdentityMap(repo);

    const principals = await map.resolve({
      businessId: "some-other-business",
      provider: "slack",
      externalSubject: "U123",
    });

    expect(principals).toBeUndefined();
  });
});
