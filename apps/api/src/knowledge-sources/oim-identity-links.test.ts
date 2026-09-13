import { describe, expect, it } from "vitest";
import type { ExternalIdentityMappingDoc, ExternalIdentityRepo } from "../identity/external-links";
import { ProvenOimKnowledgeIdentityLinks } from "./oim-identity-links";

function repo(mapping: ExternalIdentityMappingDoc | null): ExternalIdentityRepo {
  return {
    async findMapping() {
      return mapping;
    },
    async listMappingsForUser() {
      return [];
    },
    async listProvenMappingsForUser() {
      return [];
    },
    async upsertMapping() {},
    async deleteMapping() {},
    async createLinkToken() {},
    async consumeLinkToken() {
      return null;
    },
    async createBindToken() {},
    async findBindToken() {
      return null;
    },
    async consumeBindToken() {
      return null;
    },
  };
}

const input = {
  businessId: "business-1",
  provider: "wiki",
  integrationId: "wiki",
  integrationMajorVersion: 2,
  connectionId: "connection-1",
  externalTenantId: "tenant-b",
  providerId: "same-subject",
};

describe("ProvenOimKnowledgeIdentityLinks", () => {
  it("rejects the same provider subject when its proven link belongs to another tenant", async () => {
    const links = new ProvenOimKnowledgeIdentityLinks(
      repo({
        provider: "wiki",
        externalSubject: "same-subject",
        externalTenantId: "tenant-a",
        userId: "wrong-user",
        verifiedAt: new Date(),
        expiresAt: null,
        verifiedVia: "bind_link",
      })
    );

    await expect(links.linkedPrincipal(input)).resolves.toBeUndefined();
  });

  it("rejects browser-reported email mappings that do not prove account control", async () => {
    const links = new ProvenOimKnowledgeIdentityLinks(
      repo({
        provider: "wiki",
        externalSubject: "same-subject",
        externalTenantId: "tenant-b",
        userId: "user-1",
        verifiedAt: new Date(),
        expiresAt: null,
        verifiedVia: "manifest_email",
      })
    );

    await expect(links.linkedPrincipal(input)).resolves.toBeUndefined();
  });

  it("returns an exact tenant-scoped proven link", async () => {
    const links = new ProvenOimKnowledgeIdentityLinks(
      repo({
        provider: "wiki",
        externalSubject: "same-subject",
        externalTenantId: "tenant-b",
        userId: "user-1",
        verifiedAt: new Date(),
        expiresAt: null,
        verifiedVia: "link_token",
      })
    );

    await expect(links.linkedPrincipal(input)).resolves.toEqual({
      kind: "user",
      id: "user-1",
    });
  });
});
