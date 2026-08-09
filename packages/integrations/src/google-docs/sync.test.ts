import { describe, expect, it } from "vitest";
import type {
  KnowledgeChunkEmission,
  KnowledgeEmissionSink,
  KnowledgeIdentityMapPort,
  KnowledgeSourceEmission,
} from "../knowledge/source";
import type { GoogleDocsApiPort, GoogleDocsChange, GoogleDocsDocument } from "./ports";
import { InMemoryGoogleDocsCheckpointStore } from "./ports";
import { googleDocsSourceId, syncGoogleDocsKnowledge } from "./sync";

const NOW = new Date("2026-08-08T12:00:00.000Z");
const now = () => NOW;

class RecordingSink implements KnowledgeEmissionSink {
  readonly sources: KnowledgeSourceEmission[] = [];
  readonly chunks: KnowledgeChunkEmission[] = [];
  readonly removed: string[] = [];

  async emitSource(source: KnowledgeSourceEmission): Promise<void> {
    this.sources.push(source);
  }

  async emitChunk(chunk: KnowledgeChunkEmission): Promise<void> {
    this.chunks.push(chunk);
  }

  async removeSourceContent(_businessId: string, sourceId: string): Promise<void> {
    this.removed.push(sourceId);
  }

  async removeChunk(_businessId: string, _sourceId: string, chunkId: string): Promise<void> {
    this.removed.push(chunkId);
  }
}

const identity: KnowledgeIdentityMapPort = {
  async resolve({ externalSubject }) {
    const mapping: Record<string, { kind: string; id: string }[]> = {
      "alice@example.com": [{ kind: "user", id: "alice" }],
      "eng@example.com": [{ kind: "role", id: "eng" }],
    };
    return mapping[externalSubject];
  },
};

function doc(overrides: Partial<GoogleDocsDocument> = {}): GoogleDocsDocument {
  return {
    id: "doc-1",
    title: "Google Doc Plan",
    version: "v1",
    ownerExternalId: "alice@example.com",
    modifiedTime: NOW.toISOString(),
    contentHash: "hash",
    text: "orchid google docs plan",
    trashed: false,
    ...overrides,
  };
}

function api(options: {
  changes: readonly GoogleDocsChange[];
  docs: Readonly<Record<string, GoogleDocsDocument | undefined>>;
  permissions: Readonly<
    Record<string, Awaited<ReturnType<GoogleDocsApiPort["getDocumentPermissions"]>>>
  >;
}): GoogleDocsApiPort {
  return {
    async listChanged({ cursor }) {
      const start =
        cursor === undefined
          ? 0
          : options.changes.findIndex((change) => change.cursor === cursor) + 1;
      const changes = options.changes.slice(start);
      return { changes, nextCursor: changes.at(-1)?.cursor ?? cursor };
    },
    async getDocument(documentId) {
      return options.docs[documentId];
    },
    async getDocumentPermissions(documentId) {
      return options.permissions[documentId];
    },
  };
}

const base = {
  businessId: "biz-1",
  integrationId: "google-docs:test:workspace-1",
  externalTenantId: "workspace-1",
};

describe("syncGoogleDocsKnowledge", () => {
  it("emits snapshot ACLs from mapped Drive permissions", async () => {
    const sink = new RecordingSink();
    const result = await syncGoogleDocsKnowledge(
      {
        api: api({
          changes: [{ documentId: "doc-1", cursor: "c1" }],
          docs: { "doc-1": doc() },
          permissions: {
            "doc-1": [
              { type: "user", externalSubject: "alice@example.com", role: "reader" },
              { type: "group", externalSubject: "eng@example.com", role: "reader" },
              { type: "anyone", externalSubject: "anyone", role: "reader" },
              { type: "domain", externalSubject: "example.com", role: "reader" },
            ],
          },
        }),
        checkpoints: new InMemoryGoogleDocsCheckpointStore(),
        sink,
        identity,
        now,
      },
      base
    );

    expect(result.emitted).toBe(1);
    expect(sink.sources[0]?.sourceId).toBe(googleDocsSourceId("doc-1"));
    expect(sink.sources[0]?.acl?.principals).toEqual([
      { kind: "user", id: "alice" },
      { kind: "role", id: "eng" },
    ]);
    expect(sink.chunks).toHaveLength(1);
  });

  it("revalidates permissions without a content-version change", async () => {
    const checkpoints = new InMemoryGoogleDocsCheckpointStore();
    await syncGoogleDocsKnowledge(
      {
        api: api({
          changes: [{ documentId: "doc-1", cursor: "c1" }],
          docs: { "doc-1": doc() },
          permissions: {
            "doc-1": [
              { type: "user", externalSubject: "alice@example.com", role: "reader" },
              { type: "group", externalSubject: "eng@example.com", role: "reader" },
            ],
          },
        }),
        checkpoints,
        sink: new RecordingSink(),
        identity,
        now,
      },
      base
    );

    const sink = new RecordingSink();
    const result = await syncGoogleDocsKnowledge(
      {
        api: api({
          changes: [{ documentId: "doc-1", cursor: "c1" }],
          docs: { "doc-1": doc() },
          permissions: {
            "doc-1": [{ type: "user", externalSubject: "alice@example.com", role: "reader" }],
          },
        }),
        checkpoints,
        sink,
        identity,
        now,
      },
      { ...base, revalidateDocumentIds: ["doc-1"] }
    );

    expect(result.revalidated).toBe(1);
    expect(sink.sources[0]?.acl?.principals).toEqual([{ kind: "user", id: "alice" }]);
  });

  it("removes content when permissions are unreadable or the document is deleted", async () => {
    const sink = new RecordingSink();
    await syncGoogleDocsKnowledge(
      {
        api: api({
          changes: [
            { documentId: "doc-1", cursor: "c1" },
            { documentId: "gone", cursor: "c2", removed: true },
          ],
          docs: { "doc-1": doc() },
          permissions: { "doc-1": undefined },
        }),
        checkpoints: new InMemoryGoogleDocsCheckpointStore(),
        sink,
        identity,
        now,
      },
      base
    );

    expect(sink.sources.map((source) => source.verification)).toEqual([
      "unverifiable",
      "unverifiable",
    ]);
    expect(sink.removed).toEqual([googleDocsSourceId("doc-1"), googleDocsSourceId("gone")]);
    expect(sink.chunks).toEqual([]);
  });
});
