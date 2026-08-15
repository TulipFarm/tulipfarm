import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type {
  DriveApiPort,
  DriveChange,
  DriveFile,
  DrivePermission,
  GoogleDocsApiPort,
  GoogleDocsChange,
  GoogleDocsDocument,
  GoogleDocsPermission,
  NotionApiPort,
  NotionChange,
  NotionPage,
} from "@tulipfarm/integrations";
import {
  syncDriveKnowledge,
  syncGoogleDocsKnowledge,
  syncNotionKnowledge,
} from "@tulipfarm/integrations";
import type { EmbeddingPort } from "@tulipfarm/knowledge";
import {
  KNOWLEDGE_TOOLS,
  KnowledgeService,
  PageRetrievalService,
  PgKnowledgeChunkRepo,
  PgKnowledgePageRepo,
  PgKnowledgeRevisionRepo,
} from "@tulipfarm/knowledge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryExternalIdentityRepo } from "../identity/fakes";
import { ExternalLinkKnowledgeIdentityMap } from "../identity/knowledge-identity-map";
import { PgKnowledgeEmissionSink } from "../knowledge-sources/emission-sink";
import { PgKnowledgeIndexStore } from "../knowledge-sources/index-store";
import { PgKnowledgeSourceStore } from "../knowledge-sources/source-store";
import { PgProviderKnowledgeCheckpointStore } from "../knowledge-sources/sync-checkpoint-store";
import { makeMigratedPglite } from "../test/pglite";

const BUSINESS = DEPLOYMENT_BUSINESS_ID;
const NOW = new Date("2026-08-08T12:00:00.000Z");
const SECRET_TEXT = "orchid launch plan for k3 readers";

const lexicalOnlyEmbeddings: EmbeddingPort = {
  isAvailable: () => false,
  embedMany: async () => ({ embeddings: [], dimension: 0 }),
  getActive: () => null,
  getDimension: () => null,
  consumePendingReindex: () => false,
};

class FakeDriveApi implements DriveApiPort {
  changes: DriveChange[] = [{ fileId: "doc-1", cursor: "c1" }];
  files = new Map<string, DriveFile | undefined>([["doc-1", this.file()]]);
  permissions = new Map<string, readonly DrivePermission[] | undefined>([
    ["doc-1", [{ type: "user", externalSubject: "alice@example.com", role: "reader" }]],
  ]);

  async listChanges({ cursor }: { cursor?: string; pageLimit: number }) {
    const start =
      cursor === undefined ? 0 : this.changes.findIndex((change) => change.cursor === cursor) + 1;
    const changes = this.changes.slice(start);
    return { changes, nextCursor: changes.at(-1)?.cursor ?? cursor };
  }

  async getFile(fileId: string) {
    return this.files.get(fileId);
  }

  async getPermissions(fileId: string) {
    return this.permissions.get(fileId);
  }

  async exportText(fileId: string) {
    return this.files.get(fileId) === undefined
      ? undefined
      : { text: SECRET_TEXT, mimeType: "text/plain" };
  }

  file(overrides: Partial<DriveFile> = {}): DriveFile {
    return {
      id: "doc-1",
      name: "Drive Plan",
      mimeType: "text/plain",
      version: "1",
      ownerExternalId: "alice@example.com",
      contentHash: "hash",
      modifiedTime: NOW.toISOString(),
      trashed: false,
      ...overrides,
    };
  }
}

class FakeGoogleDocsApi implements GoogleDocsApiPort {
  changes: GoogleDocsChange[] = [{ documentId: "doc-1", cursor: "c1" }];
  docs = new Map<string, GoogleDocsDocument | undefined>([["doc-1", this.doc()]]);
  permissions = new Map<string, readonly GoogleDocsPermission[] | undefined>([
    ["doc-1", [{ type: "user", externalSubject: "alice@example.com", role: "reader" }]],
  ]);

  async listChanged({ cursor }: { cursor?: string; pageLimit: number }) {
    const start =
      cursor === undefined ? 0 : this.changes.findIndex((change) => change.cursor === cursor) + 1;
    const changes = this.changes.slice(start);
    return { changes, nextCursor: changes.at(-1)?.cursor ?? cursor };
  }

  async getDocument(documentId: string) {
    return this.docs.get(documentId);
  }

  async getDocumentPermissions(documentId: string) {
    return this.permissions.get(documentId);
  }

  doc(overrides: Partial<GoogleDocsDocument> = {}): GoogleDocsDocument {
    return {
      id: "doc-1",
      title: "Google Docs Plan",
      version: "1",
      ownerExternalId: "alice@example.com",
      modifiedTime: NOW.toISOString(),
      contentHash: "hash",
      text: SECRET_TEXT,
      trashed: false,
      ...overrides,
    };
  }
}

class FakeNotionApi implements NotionApiPort {
  changes: NotionChange[] = [{ pageId: "doc-1", cursor: "c1" }];
  pages = new Map<string, NotionPage | undefined>([["doc-1", this.page()]]);
  permissions = new Map<string, readonly string[] | undefined>([["doc-1", ["notion_alice"]]]);

  async listChanged({ cursor }: { cursor?: string; pageLimit: number }) {
    const start =
      cursor === undefined ? 0 : this.changes.findIndex((change) => change.cursor === cursor) + 1;
    const changes = this.changes.slice(start);
    return { changes, nextCursor: changes.at(-1)?.cursor ?? cursor };
  }

  async getPage(pageId: string) {
    return this.pages.get(pageId);
  }

  async getPagePermissions(pageId: string) {
    return this.permissions.get(pageId)?.map((userId) => ({ userId }));
  }

  page(overrides: Partial<NotionPage> = {}): NotionPage {
    return {
      id: "doc-1",
      title: "Notion Plan",
      version: "1",
      ownerExternalId: "notion_alice",
      lastEditedTime: NOW.toISOString(),
      content: SECRET_TEXT,
      ...overrides,
    };
  }
}

describe("K3 Knowledge security through query_knowledge", () => {
  let db: PGlite;
  let sources: PgKnowledgeSourceStore;
  let index: PgKnowledgeIndexStore;
  let service: KnowledgeService;
  let now: Date;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    sources = new PgKnowledgeSourceStore(db);
    index = new PgKnowledgeIndexStore(db, lexicalOnlyEmbeddings);
    now = NOW;
    service = new KnowledgeService({
      pages: new PgKnowledgePageRepo(db),
      chunks: new PgKnowledgeChunkRepo(db),
      revisions: new PgKnowledgeRevisionRepo(db),
      embeddings: lexicalOnlyEmbeddings,
      retrieval: new PageRetrievalService(db),
      sourceRetrieval: { sources, index, now: () => now },
    });
  });

  afterEach(async () => {
    await db.close();
  });

  function identity(provider: string): ExternalLinkKnowledgeIdentityMap {
    const repo = new MemoryExternalIdentityRepo();
    const aliceSubject = provider === "notion" ? "notion_alice" : "alice@example.com";
    const bobSubject = provider === "notion" ? "notion_bob" : "bob@example.com";
    repo.mappings.push({
      provider,
      externalSubject: aliceSubject,
      userId: "alice",
      verifiedAt: NOW,
      expiresAt: null,
    });
    repo.mappings.push({
      provider,
      externalSubject: bobSubject,
      userId: "bob",
      verifiedAt: NOW,
      expiresAt: null,
    });
    return new ExternalLinkKnowledgeIdentityMap(repo);
  }

  async function queryAs(userId: string): Promise<unknown> {
    const tool = KNOWLEDGE_TOOLS.find((candidate) => candidate.name === "query_knowledge");
    if (tool === undefined) throw new Error("query_knowledge not registered");
    const outcome = await tool.handler({ query: "orchid", limit: 10 }, { userId, service });
    expect(outcome.success).toBe(true);
    if (!outcome.success) throw new Error(outcome.error.message);
    return outcome.data;
  }

  function resultCount(data: unknown): number {
    if (typeof data !== "object" || data === null || !("results" in data)) return 0;
    const results = (data as { results?: unknown }).results;
    return Array.isArray(results) ? results.length : 0;
  }

  describe("Google Drive", () => {
    let api: FakeDriveApi;

    beforeEach(() => {
      api = new FakeDriveApi();
    });

    async function sync(
      options: { revalidateFileIds?: readonly string[]; aclMaximumAgeSeconds?: number } = {}
    ) {
      await syncDriveKnowledge(
        {
          api,
          checkpoints: new PgProviderKnowledgeCheckpointStore(db, "google-drive"),
          sink: new PgKnowledgeEmissionSink(sources, index),
          identity: identity("google-drive"),
          now: () => NOW,
        },
        {
          businessId: BUSINESS,
          integrationId: "google-drive:test:tenant",
          externalTenantId: "tenant",
          extraction: {
            rules: [
              {
                id: "allow",
                effect: "allow",
                action: "knowledge.extract",
                resourceType: "knowledge_source",
                dataClass: "internal",
              },
            ],
          },
          ...options,
        }
      );
    }

    it("excludes a file from a user without Drive access", async () => {
      await sync();
      expect(resultCount(await queryAs("bob"))).toBe(0);
    });

    it("revokes narrowed permissions while retained users keep access", async () => {
      api.permissions.set("doc-1", [
        { type: "user", externalSubject: "alice@example.com", role: "reader" },
        { type: "user", externalSubject: "bob@example.com", role: "reader" },
      ]);
      await sync();
      expect(resultCount(await queryAs("bob"))).toBe(1);
      api.permissions.set("doc-1", [
        { type: "user", externalSubject: "alice@example.com", role: "reader" },
      ]);
      await sync({ revalidateFileIds: ["doc-1"] });
      expect(resultCount(await queryAs("bob"))).toBe(0);
      expect(resultCount(await queryAs("alice"))).toBe(1);
    });

    it("removes deleted files from results", async () => {
      await sync();
      api.changes = [{ fileId: "doc-1", cursor: "c2", removed: true }];
      await sync();
      expect(resultCount(await queryAs("alice"))).toBe(0);
    });

    it("does not grant access for unmapped, link-shared, or domain-shared permissions", async () => {
      api.permissions.set("doc-1", [
        { type: "anyone", externalSubject: "anyone", role: "reader" },
        { type: "domain", externalSubject: "example.com", role: "reader" },
      ]);
      await sync();
      expect(resultCount(await queryAs("alice"))).toBe(0);
    });

    it("excludes files with missing or stale ACL data", async () => {
      api.permissions.set("doc-1", undefined);
      await sync();
      expect(resultCount(await queryAs("alice"))).toBe(0);
      api.permissions.set("doc-1", [
        { type: "user", externalSubject: "alice@example.com", role: "reader" },
      ]);
      api.changes = [{ fileId: "doc-2", cursor: "c2" }];
      api.files.set("doc-2", api.file({ id: "doc-2" }));
      api.permissions.set("doc-2", [
        { type: "user", externalSubject: "alice@example.com", role: "reader" },
      ]);
      await sync({ aclMaximumAgeSeconds: 1 });
      now = new Date(NOW.getTime() + 2_000);
      expect(resultCount(await queryAs("alice"))).toBe(0);
    });
  });

  describe("Google Docs", () => {
    let api: FakeGoogleDocsApi;

    beforeEach(() => {
      api = new FakeGoogleDocsApi();
    });

    async function sync(
      options: { revalidateDocumentIds?: readonly string[]; aclMaximumAgeSeconds?: number } = {}
    ) {
      await syncGoogleDocsKnowledge(
        {
          api,
          checkpoints: new PgProviderKnowledgeCheckpointStore(db, "google-docs"),
          sink: new PgKnowledgeEmissionSink(sources, index),
          identity: identity("google-docs"),
          now: () => NOW,
        },
        {
          businessId: BUSINESS,
          integrationId: "google-docs:test:tenant",
          externalTenantId: "tenant",
          ...options,
        }
      );
    }

    it("excludes a document from a user without Docs access", async () => {
      await sync();
      expect(resultCount(await queryAs("bob"))).toBe(0);
    });

    it("revokes narrowed permissions while retained users keep access", async () => {
      api.permissions.set("doc-1", [
        { type: "user", externalSubject: "alice@example.com", role: "reader" },
        { type: "user", externalSubject: "bob@example.com", role: "reader" },
      ]);
      await sync();
      expect(resultCount(await queryAs("bob"))).toBe(1);
      api.permissions.set("doc-1", [
        { type: "user", externalSubject: "alice@example.com", role: "reader" },
      ]);
      await sync({ revalidateDocumentIds: ["doc-1"] });
      expect(resultCount(await queryAs("bob"))).toBe(0);
      expect(resultCount(await queryAs("alice"))).toBe(1);
    });

    it("removes deleted documents from results", async () => {
      await sync();
      api.changes = [{ documentId: "doc-1", cursor: "c2", removed: true }];
      await sync();
      expect(resultCount(await queryAs("alice"))).toBe(0);
    });

    it("does not grant access for unmapped, link-shared, or domain-shared permissions", async () => {
      api.permissions.set("doc-1", [
        { type: "anyone", externalSubject: "anyone", role: "reader" },
        { type: "domain", externalSubject: "example.com", role: "reader" },
      ]);
      await sync();
      expect(resultCount(await queryAs("alice"))).toBe(0);
    });

    it("excludes documents with missing or stale ACL data", async () => {
      api.permissions.set("doc-1", undefined);
      await sync();
      expect(resultCount(await queryAs("alice"))).toBe(0);
      api.permissions.set("doc-1", [
        { type: "user", externalSubject: "alice@example.com", role: "reader" },
      ]);
      api.changes = [{ documentId: "doc-2", cursor: "c2" }];
      api.docs.set("doc-2", api.doc({ id: "doc-2" }));
      api.permissions.set("doc-2", [
        { type: "user", externalSubject: "alice@example.com", role: "reader" },
      ]);
      await sync({ aclMaximumAgeSeconds: 1 });
      now = new Date(NOW.getTime() + 2_000);
      expect(resultCount(await queryAs("alice"))).toBe(0);
    });
  });

  describe("Notion", () => {
    let api: FakeNotionApi;

    beforeEach(() => {
      api = new FakeNotionApi();
    });

    async function sync(
      options: { revalidatePageIds?: readonly string[]; aclMaximumAgeSeconds?: number } = {}
    ) {
      await syncNotionKnowledge(
        {
          api,
          checkpoints: new PgProviderKnowledgeCheckpointStore(db, "notion"),
          sink: new PgKnowledgeEmissionSink(sources, index),
          identity: identity("notion"),
          now: () => NOW,
        },
        {
          businessId: BUSINESS,
          integrationId: "notion:test:workspace",
          externalTenantId: "workspace",
          ...options,
        }
      );
    }

    it("excludes a page from a user without Notion access", async () => {
      await sync();
      expect(resultCount(await queryAs("bob"))).toBe(0);
    });

    it("revokes narrowed permissions while retained users keep access", async () => {
      api.permissions.set("doc-1", ["notion_alice", "notion_bob"]);
      await sync();
      expect(resultCount(await queryAs("bob"))).toBe(1);
      api.permissions.set("doc-1", ["notion_alice"]);
      await sync({ revalidatePageIds: ["doc-1"] });
      expect(resultCount(await queryAs("bob"))).toBe(0);
      expect(resultCount(await queryAs("alice"))).toBe(1);
    });

    it("removes deleted pages from results", async () => {
      await sync();
      api.changes = [{ pageId: "doc-1", cursor: "c2", deleted: true }];
      await sync();
      expect(resultCount(await queryAs("alice"))).toBe(0);
    });

    it("does not grant access for unmapped Notion users", async () => {
      api.permissions.set("doc-1", ["notion_unmapped"]);
      await sync();
      expect(resultCount(await queryAs("alice"))).toBe(0);
    });

    it("excludes pages with missing or stale ACL data", async () => {
      api.permissions.set("doc-1", undefined);
      await sync();
      expect(resultCount(await queryAs("alice"))).toBe(0);
      api.permissions.set("doc-1", ["notion_alice"]);
      api.changes = [{ pageId: "doc-2", cursor: "c2" }];
      api.pages.set("doc-2", api.page({ id: "doc-2" }));
      api.permissions.set("doc-2", ["notion_alice"]);
      await sync({ aclMaximumAgeSeconds: 1 });
      now = new Date(NOW.getTime() + 2_000);
      expect(resultCount(await queryAs("alice"))).toBe(0);
    });
  });
});
