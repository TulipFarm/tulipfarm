import { describe, expect, it } from "vitest";
import type {
  KnowledgeChunkEmission,
  KnowledgeEmissionSink,
  KnowledgeIdentityMapPort,
  KnowledgeSourceEmission,
} from "../knowledge/source";
import type { ConfluenceApiPort, ConfluenceChange, ConfluencePage } from "./ports";
import { InMemoryConfluenceCheckpointStore } from "./ports";
import { confluenceSourceId, syncConfluenceKnowledge } from "./sync";

const NOW = new Date("2026-08-08T12:00:00.000Z");
const now = () => NOW;

class RecordingSink implements KnowledgeEmissionSink {
  readonly sources: KnowledgeSourceEmission[] = [];
  readonly chunks: KnowledgeChunkEmission[] = [];
  readonly removedSources: string[] = [];
  failOnSourceId?: string;

  async emitSource(source: KnowledgeSourceEmission): Promise<void> {
    if (source.sourceId === this.failOnSourceId) throw new Error("sink unavailable");
    this.sources.push(source);
  }

  async emitChunk(chunk: KnowledgeChunkEmission): Promise<void> {
    this.chunks.push(chunk);
  }

  async removeSourceContent(_businessId: string, sourceId: string): Promise<void> {
    this.removedSources.push(sourceId);
  }

  async removeChunk(_businessId: string, _sourceId: string, chunkId: string): Promise<void> {
    this.removedSources.push(chunkId);
  }
}

const identity: KnowledgeIdentityMapPort = {
  async resolve({ externalSubject }) {
    const mapping: Record<string, { kind: string; id: string }[]> = {
      acct_alice: [{ kind: "user", id: "user-1" }],
      acct_hr: [{ kind: "user", id: "user-2" }],
    };
    return mapping[externalSubject];
  },
};

function page(overrides: Partial<ConfluencePage> = {}): ConfluencePage {
  return {
    id: "page-1",
    title: "Launch Runbook",
    spaceId: "space-1",
    spaceKey: "ENG",
    version: "7",
    ownerAccountId: "acct_alice",
    updatedAt: NOW.toISOString(),
    content: "alpha launch checklist\n\nbeta rollout details",
    ...overrides,
  };
}

interface StubOptions {
  changes: readonly ConfluenceChange[];
  pages: Readonly<Record<string, ConfluencePage | undefined>>;
  permissions: Readonly<Record<string, readonly string[] | undefined>>;
}

function stubApi(options: StubOptions): ConfluenceApiPort {
  return {
    async listChanged({ cursor }) {
      const start =
        cursor === undefined
          ? 0
          : options.changes.findIndex((change) => change.cursor === cursor) + 1;
      const changes = options.changes.slice(start);
      return { changes, nextCursor: changes.at(-1)?.cursor ?? cursor };
    },
    async getPage(pageId) {
      return options.pages[pageId];
    },
    async getPagePermissions(pageId) {
      const permissions = options.permissions[pageId];
      return permissions?.map((accountId) => ({ accountId }));
    },
  };
}

const base = {
  businessId: "biz-1",
  integrationId: "int-confluence",
  externalTenantId: "cloud-1",
};

describe("syncConfluenceKnowledge", () => {
  it("emits a page source with a snapshot ACL from mapped Confluence accounts", async () => {
    const sink = new RecordingSink();
    const result = await syncConfluenceKnowledge(
      {
        api: stubApi({
          changes: [{ pageId: "page-1", cursor: "c1" }],
          pages: { "page-1": page() },
          permissions: { "page-1": ["acct_alice", "acct_unmapped"] },
        }),
        checkpoints: new InMemoryConfluenceCheckpointStore(),
        sink,
        identity,
        now,
      },
      base
    );

    expect(result.emitted).toBe(1);
    expect(sink.sources[0]).toMatchObject({
      sourceId: "confluence:page-1",
      provider: "confluence",
      verification: "verified",
      accessControl: { mode: "snapshot", maximumAgeSeconds: 300 },
    });
    expect(sink.sources[0]?.acl?.principals).toEqual([{ kind: "user", id: "user-1" }]);
    expect(sink.chunks.map((chunk) => chunk.sourceId)).toEqual(["confluence:page-1"]);
  });

  it("emits no grants for unmapped Confluence identities", async () => {
    const sink = new RecordingSink();
    await syncConfluenceKnowledge(
      {
        api: stubApi({
          changes: [{ pageId: "page-1", cursor: "c1" }],
          pages: { "page-1": page() },
          permissions: { "page-1": ["acct_unmapped"] },
        }),
        checkpoints: new InMemoryConfluenceCheckpointStore(),
        sink,
        identity,
        now,
      },
      base
    );

    expect(sink.sources[0]?.acl?.principals).toEqual([]);
  });

  it("narrows permissions on revalidation without requiring a content-version change", async () => {
    const checkpoints = new InMemoryConfluenceCheckpointStore();
    const first = new RecordingSink();
    const firstApi = stubApi({
      changes: [{ pageId: "page-1", cursor: "c1" }],
      pages: { "page-1": page({ version: "7" }) },
      permissions: { "page-1": ["acct_alice", "acct_hr"] },
    });
    await syncConfluenceKnowledge({ api: firstApi, checkpoints, sink: first, identity, now }, base);

    const second = new RecordingSink();
    const result = await syncConfluenceKnowledge(
      {
        api: stubApi({
          changes: [{ pageId: "page-1", cursor: "c1" }],
          pages: { "page-1": page({ version: "7" }) },
          permissions: { "page-1": ["acct_hr"] },
        }),
        checkpoints,
        sink: second,
        identity,
        now,
      },
      { ...base, revalidatePageIds: ["page-1"] }
    );

    expect(result.revalidated).toBe(1);
    expect(second.sources[0]?.revision).toBe("7");
    expect(second.sources[0]?.acl?.principals).toEqual([{ kind: "user", id: "user-2" }]);
    expect(second.sources[0]?.acl?.aclRevision).not.toBe(first.sources.at(-1)?.acl?.aclRevision);
  });

  it("emits an unverifiable source and removes content when permissions cannot be read", async () => {
    const sink = new RecordingSink();
    const result = await syncConfluenceKnowledge(
      {
        api: stubApi({
          changes: [{ pageId: "page-1", cursor: "c1" }],
          pages: { "page-1": page() },
          permissions: { "page-1": undefined },
        }),
        checkpoints: new InMemoryConfluenceCheckpointStore(),
        sink,
        identity,
        now,
      },
      base
    );

    expect(result.unverifiable).toBe(1);
    expect(sink.sources[0]?.verification).toBe("unverifiable");
    expect(sink.chunks).toEqual([]);
    expect(sink.removedSources).toEqual([confluenceSourceId("page-1")]);
  });

  it("marks deleted pages deleted and removes their indexed content", async () => {
    const sink = new RecordingSink();
    const result = await syncConfluenceKnowledge(
      {
        api: stubApi({
          changes: [{ pageId: "gone", cursor: "c1", deleted: true }],
          pages: {},
          permissions: {},
        }),
        checkpoints: new InMemoryConfluenceCheckpointStore(),
        sink,
        identity,
        now,
      },
      base
    );

    expect(result.deleted).toBe(1);
    expect(sink.sources[0]?.status).toBe("deleted");
    expect(sink.chunks).toEqual([]);
    expect(sink.removedSources).toEqual([confluenceSourceId("gone")]);
  });

  it("advances the checkpoint only after a change fully commits", async () => {
    const checkpoints = new InMemoryConfluenceCheckpointStore();
    const sink = new RecordingSink();
    sink.failOnSourceId = confluenceSourceId("b");

    const result = await syncConfluenceKnowledge(
      {
        api: stubApi({
          changes: [
            { pageId: "a", cursor: "c1" },
            { pageId: "b", cursor: "c2" },
          ],
          pages: { a: page({ id: "a" }), b: page({ id: "b" }) },
          permissions: { a: ["acct_alice"], b: ["acct_alice"] },
        }),
        checkpoints,
        sink,
        identity,
        now,
      },
      base
    );

    expect(result.failures).toEqual([{ code: "emit_failed" }]);
    expect((await checkpoints.load("int-confluence"))?.cursor).toBe("c1");
  });
});
