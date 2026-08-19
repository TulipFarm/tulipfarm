import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { describe, expect, it } from "vitest";
import type { IdentityVerificationMethod } from "./external-links";
import { MemoryExternalIdentityRepo } from "./fakes";
import {
  ExternalLinkKnowledgeIdentityMap,
  PROVEN_LINK_VERIFICATION,
} from "./knowledge-identity-map";

describe("ExternalLinkKnowledgeIdentityMap", () => {
  it("resolves a mapped Slack subject to its Tulip user principal", async () => {
    const repo = new MemoryExternalIdentityRepo();
    repo.mappings.push({
      provider: "slack",
      externalSubject: "U123",
      userId: "u1",
      verifiedAt: new Date(),
      expiresAt: null,
      verifiedVia: "link_token",
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

  describe("verification grade", () => {
    const resolveVia = async (verifiedVia: IdentityVerificationMethod | null | undefined) => {
      const repo = new MemoryExternalIdentityRepo();
      repo.mappings.push({
        provider: "slack",
        externalSubject: "U123",
        userId: "u1",
        verifiedAt: new Date(),
        expiresAt: null,
        verifiedVia,
      });
      return new ExternalLinkKnowledgeIdentityMap(repo).resolve({
        businessId: DEPLOYMENT_BUSINESS_ID,
        provider: "slack",
        externalSubject: "U123",
      });
    };

    it.each(["link_token", "bind_link"] as const)(
      "grants Knowledge access for %s, which proves control of both accounts",
      async (method) => {
        expect(await resolveVia(method)).toEqual([{ kind: "user", id: "u1" }]);
      }
    );

    // A Slack Connect counterparty controls their own users' email addresses. If a
    // provider-asserted email were enough, they could set one to our CEO's and inherit every
    // document the CEO can read. The mapping still identifies a chat sender; it grants nothing.
    it("grants no Knowledge access for manifest_email", async () => {
      expect(await resolveVia("manifest_email")).toBeUndefined();
    });

    it.each([null, undefined])(
      "grants no Knowledge access when provenance is %s, because unknown is not trusted",
      async (method) => {
        expect(await resolveVia(method)).toBeUndefined();
      }
    );

    it("keeps every knowledge-grade method out of the chat-only set", () => {
      expect(PROVEN_LINK_VERIFICATION).not.toContain("manifest_email");
    });
  });
});
