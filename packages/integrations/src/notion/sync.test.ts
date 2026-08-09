import { describe, expect, it } from "vitest";
import type {
  KnowledgeChunkEmission,
  KnowledgeEmissionSink,
  KnowledgeIdentityMapPort,
  KnowledgeSourceEmission,
} from "../knowledge/source";
import type { NotionApiPort, NotionChange, NotionPage } from "./ports";
import { InMemoryNotionCheckpointStore } from "./ports";
import { notionSourceId, syncNotionKnowledge } from "./sync";

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
      notion_alice: [{ kind: "user", id: "alice" }],
      notion_bob: [{ kind: "user", id: "bob" }],
    };
    return mapping[externalSubject];
  },
};

function page(overrides: Partial<NotionPage> = {}): NotionPage {
  return {
    id: "page-1",
    title: "Notion Plan",
    version: "v1",
    ownerExternalId: "notion_alice",
    lastEditedTime: NOW.toISOString(),
    content: "orchid launch plan",
    ...overrides,
  };
}

function api(options: {
  changes: readonly NotionChange[];
  pages: Readonly<Record<string, NotionPage | undefined>>;
  permissions: Readonly<Record<string, readonly string[] | undefined>>;
}): NotionApiPort {
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
      return options.permissions[pageId]?.map((userId) => ({ userId }));
    },
  };
}

const base = {
  businessId: "biz-1",
  integrationId: "notion:test:workspace-1",
  externalTenantId: "workspace-1",
};

describe("syncNotionKnowledge", () => {
  it("emits snapshot ACLs from mapped Notion users", async () => {
    const sink = new RecordingSink();
    const result = await syncNotionKnowledge(
      {
        api: api({
          changes: [{ pageId: "page-1", cursor: "c1" }],
          pages: { "page-1": page() },
          permissions: { "page-1": ["notion_alice", "notion_unmapped"] },
        }),
        checkpoints: new InMemoryNotionCheckpointStore(),
        sink,
        identity,
        now,
      },
      base
    );

    expect(result.emitted).toBe(1);
    expect(sink.sources[0]?.sourceId).toBe(notionSourceId("page-1"));
    expect(sink.sources[0]?.acl?.principals).toEqual([{ kind: "user", id: "alice" }]);
    expect(sink.chunks).toHaveLength(1);
  });

  it("revalidates permissions without a content-version change", async () => {
    const checkpoints = new InMemoryNotionCheckpointStore();
    const first = new RecordingSink();
    await syncNotionKnowledge(
      {
        api: api({
          changes: [{ pageId: "page-1", cursor: "c1" }],
          pages: { "page-1": page() },
          permissions: { "page-1": ["notion_alice", "notion_bob"] },
        }),
        checkpoints,
        sink: first,
        identity,
        now,
      },
      base
    );

    const second = new RecordingSink();
    const result = await syncNotionKnowledge(
      {
        api: api({
          changes: [{ pageId: "page-1", cursor: "c1" }],
          pages: { "page-1": page() },
          permissions: { "page-1": ["notion_alice"] },
        }),
        checkpoints,
        sink: second,
        identity,
        now,
      },
      { ...base, revalidatePageIds: ["page-1"] }
    );

    expect(result.revalidated).toBe(1);
    expect(second.sources[0]?.acl?.principals).toEqual([{ kind: "user", id: "alice" }]);
  });

  it("removes content when ACLs are missing or the page is deleted", async () => {
    const sink = new RecordingSink();
    await syncNotionKnowledge(
      {
        api: api({
          changes: [
            { pageId: "page-1", cursor: "c1" },
            { pageId: "gone", cursor: "c2", deleted: true },
          ],
          pages: { "page-1": page() },
          permissions: { "page-1": undefined },
        }),
        checkpoints: new InMemoryNotionCheckpointStore(),
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
    expect(sink.removed).toEqual([notionSourceId("page-1"), notionSourceId("gone")]);
    expect(sink.chunks).toEqual([]);
  });
});
