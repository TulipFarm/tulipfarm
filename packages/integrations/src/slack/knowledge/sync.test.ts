import { describe, expect, it } from "vitest";
import type {
  KnowledgeChunkEmission,
  KnowledgeEmissionSink,
  KnowledgeIdentityMapPort,
  KnowledgeSourceEmission,
} from "../../knowledge/source";
import type { SlackKnowledgeApiPort, SlackKnowledgeChannel, SlackKnowledgeMessage } from "./ports";
import { InMemorySlackKnowledgeCheckpointStore } from "./ports";
import { SLACK_KNOWLEDGE_ACL_MAX_AGE_SECONDS, syncSlackKnowledge } from "./sync";

const NOW = new Date("2026-07-26T12:00:00.000Z");
const now = () => NOW;

class RecordingSink implements KnowledgeEmissionSink {
  readonly sources: KnowledgeSourceEmission[] = [];
  readonly chunks: KnowledgeChunkEmission[] = [];
  readonly removedSources: string[] = [];
  readonly removedChunks: string[] = [];
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
    this.removedChunks.push(chunkId);
  }
}

const identity: KnowledgeIdentityMapPort = {
  async resolve({ externalSubject }) {
    const mapping: Record<string, { kind: string; id: string }[]> = {
      U_ALICE: [{ kind: "user", id: "user-1" }],
      U_HR: [{ kind: "user", id: "user-2" }],
    };
    return mapping[externalSubject];
  },
};

function channel(overrides: Partial<SlackKnowledgeChannel> = {}): SlackKnowledgeChannel {
  return {
    id: "C_GENERAL",
    name: "general",
    kind: "public",
    teamId: "T1",
    archived: false,
    ...overrides,
  };
}

function message(overrides: Partial<SlackKnowledgeMessage> = {}): SlackKnowledgeMessage {
  return {
    channelId: "C_GENERAL",
    ts: "1700000000.000100",
    userExternalId: "U_ALICE",
    text: "deploy window is friday",
    ...overrides,
  };
}

interface StubOptions {
  channels: readonly SlackKnowledgeChannel[];
  members: Readonly<Record<string, readonly string[] | undefined>>;
  messages: Readonly<Record<string, readonly SlackKnowledgeMessage[]>>;
  failMessagesFor?: string;
}

function stubApi(options: StubOptions): SlackKnowledgeApiPort {
  return {
    async listChannels() {
      return options.channels;
    },
    async listMembers(channelId) {
      return options.members[channelId];
    },
    async listMessages({ channelId, cursor }) {
      if (channelId === options.failMessagesFor) {
        throw new Error(`slack: 403 reading #secret-comp for U_ALICE`);
      }
      const all = options.messages[channelId] ?? [];
      const start = cursor === undefined ? 0 : all.findIndex((m) => m.ts === cursor) + 1;
      const messages = all.slice(start);
      return { messages, nextCursor: messages.at(-1)?.ts ?? cursor };
    },
  };
}

const base = {
  businessId: "biz-1",
  integrationId: "int-slack",
  externalTenantId: "T1",
};

describe("syncSlackKnowledge", () => {
  it("emits a public channel with a snapshot ACL from its mapped membership", async () => {
    const api = stubApi({
      channels: [channel()],
      members: { C_GENERAL: ["U_ALICE", "U_UNMAPPED"] },
      messages: { C_GENERAL: [message()] },
    });
    const sink = new RecordingSink();
    const result = await syncSlackKnowledge(
      { api, checkpoints: new InMemorySlackKnowledgeCheckpointStore(), sink, identity, now },
      base
    );

    expect(result.emitted).toBe(1);
    const source = sink.sources[0];
    expect(source?.sourceId).toBe("slack:C_GENERAL");
    expect(source?.verification).toBe("verified");
    expect(source?.accessControl).toEqual({
      mode: "snapshot",
      aclRevision: expect.any(String),
      maximumAgeSeconds: SLACK_KNOWLEDGE_ACL_MAX_AGE_SECONDS,
    });
    // The unmapped member is dropped, never turned into an implicit grant.
    expect(source?.acl?.principals).toEqual([{ kind: "user", id: "user-1" }]);
    expect(sink.chunks).toHaveLength(1);
    expect(sink.chunks[0]?.chunkId).toBe("slack:C_GENERAL#1700000000.000100");
  });

  it("emits private channels and DMs as live-authorized with no cached ACL", async () => {
    const api = stubApi({
      channels: [
        channel({ id: "C_COMP", name: "secret-comp", kind: "private" }),
        channel({ id: "D_HR", name: "dm-hr", kind: "dm" }),
      ],
      members: { C_COMP: ["U_HR"], D_HR: ["U_HR"] },
      messages: {
        C_COMP: [
          message({ channelId: "C_COMP", userExternalId: "U_HR", text: "band 7 is 210000" }),
        ],
        D_HR: [message({ channelId: "D_HR", userExternalId: "U_HR", text: "jane is leaving" })],
      },
    });
    const sink = new RecordingSink();
    await syncSlackKnowledge(
      { api, checkpoints: new InMemorySlackKnowledgeCheckpointStore(), sink, identity, now },
      base
    );

    for (const source of sink.sources) {
      expect(source.accessControl).toEqual({ mode: "live", maximumAgeSeconds: 60 });
      expect(source.acl).toBeUndefined();
      expect(source.classification).toEqual(["restricted"]);
    }
    expect(sink.chunks.map((chunk) => chunk.classification)).toEqual([
      ["restricted"],
      ["restricted"],
    ]);
  });

  it("emits an unverifiable source, and no content, when membership cannot be read", async () => {
    const api = stubApi({
      channels: [channel({ id: "C_COMP", name: "secret-comp", kind: "private" })],
      members: { C_COMP: undefined },
      messages: { C_COMP: [message({ channelId: "C_COMP", text: "band 7 is 210000" })] },
    });
    const sink = new RecordingSink();
    const result = await syncSlackKnowledge(
      { api, checkpoints: new InMemorySlackKnowledgeCheckpointStore(), sink, identity, now },
      base
    );

    expect(result.unverifiable).toBe(1);
    expect(sink.sources[0]?.verification).toBe("unverifiable");
    expect(sink.chunks).toEqual([]);
    expect(sink.removedSources).toEqual(["slack:C_COMP"]);
  });

  it("re-emits an edited message under its edit revision", async () => {
    const api = stubApi({
      channels: [channel()],
      members: { C_GENERAL: ["U_ALICE"] },
      messages: {
        C_GENERAL: [message({ text: "deploy window is monday", editedTs: "1700000009.000000" })],
      },
    });
    const sink = new RecordingSink();
    await syncSlackKnowledge(
      { api, checkpoints: new InMemorySlackKnowledgeCheckpointStore(), sink, identity, now },
      base
    );

    expect(sink.chunks[0]?.revision).toBe("1700000009.000000");
    expect(sink.chunks[0]?.text).toBe("deploy window is monday");
  });

  it("removes a deleted message's text instead of indexing it", async () => {
    const api = stubApi({
      channels: [channel()],
      members: { C_GENERAL: ["U_ALICE"] },
      messages: {
        C_GENERAL: [
          message({ ts: "1700000000.000100" }),
          message({ ts: "1700000001.000100", text: "oops wrong channel", deleted: true }),
        ],
      },
    });
    const sink = new RecordingSink();
    const result = await syncSlackKnowledge(
      { api, checkpoints: new InMemorySlackKnowledgeCheckpointStore(), sink, identity, now },
      base
    );

    expect(result.messagesRemoved).toBe(1);
    expect(sink.removedChunks).toEqual(["slack:C_GENERAL#1700000001.000100"]);
    expect(sink.chunks.map((chunk) => chunk.chunkId)).toEqual([
      "slack:C_GENERAL#1700000000.000100",
    ]);
    expect(JSON.stringify(sink.chunks)).not.toContain("wrong channel");
  });

  it("skips archived channels' content while keeping the source citable", async () => {
    const api = stubApi({
      channels: [channel({ id: "C_OLD", name: "old", archived: true })],
      members: { C_OLD: ["U_ALICE"] },
      messages: { C_OLD: [message({ channelId: "C_OLD" })] },
    });
    const sink = new RecordingSink();
    await syncSlackKnowledge(
      { api, checkpoints: new InMemorySlackKnowledgeCheckpointStore(), sink, identity, now },
      base
    );

    expect(sink.sources[0]?.status).toBe("revoked");
    expect(sink.chunks).toEqual([]);
    expect(sink.removedSources).toEqual(["slack:C_OLD"]);
  });

  describe("durable checkpoints", () => {
    it("advances a channel checkpoint only past messages that fully committed", async () => {
      const api = stubApi({
        channels: [channel()],
        members: { C_GENERAL: ["U_ALICE"] },
        messages: {
          C_GENERAL: [message({ ts: "1" }), message({ ts: "2" }), message({ ts: "3" })],
        },
      });
      const checkpoints = new InMemorySlackKnowledgeCheckpointStore();
      const sink = new RecordingSink();
      await syncSlackKnowledge({ api, checkpoints, sink, identity, now }, base);

      expect((await checkpoints.load("int-slack", "C_GENERAL"))?.cursor).toBe("3");

      const replay = new RecordingSink();
      const result = await syncSlackKnowledge(
        { api, checkpoints, sink: replay, identity, now },
        base
      );
      expect(result.messagesIndexed).toBe(0);
      expect(replay.chunks).toEqual([]);
    });

    it("keeps one failing channel from stalling or skipping the others", async () => {
      const api = stubApi({
        channels: [
          channel({ id: "C_COMP", name: "secret-comp", kind: "private" }),
          channel({ id: "C_GENERAL", name: "general" }),
        ],
        members: { C_COMP: ["U_HR"], C_GENERAL: ["U_ALICE"] },
        messages: { C_GENERAL: [message()] },
        failMessagesFor: "C_COMP",
      });
      const checkpoints = new InMemorySlackKnowledgeCheckpointStore();
      const sink = new RecordingSink();
      const result = await syncSlackKnowledge({ api, checkpoints, sink, identity, now }, base);

      expect(result.failures).toEqual([{ code: "messages_failed" }]);
      expect(result.messagesIndexed).toBe(1);
      expect(await checkpoints.load("int-slack", "C_COMP")).toBeUndefined();
      expect((await checkpoints.load("int-slack", "C_GENERAL"))?.cursor).toBe("1700000000.000100");
    });
  });

  it("never reports private channel identity, membership, or text in its result", async () => {
    const api = stubApi({
      channels: [
        channel({ id: "C_COMP", name: "secret-comp", kind: "private" }),
        channel({ id: "C_GENERAL", name: "general" }),
      ],
      members: { C_COMP: ["U_HR"], C_GENERAL: ["U_ALICE"] },
      messages: {
        C_COMP: [message({ channelId: "C_COMP", text: "band 7 is 210000" })],
        C_GENERAL: [message()],
      },
      failMessagesFor: "C_COMP",
    });
    const sink = new RecordingSink();
    const result = await syncSlackKnowledge(
      { api, checkpoints: new InMemorySlackKnowledgeCheckpointStore(), sink, identity, now },
      base
    );

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret-comp");
    expect(serialized).not.toContain("C_COMP");
    expect(serialized).not.toContain("U_HR");
    expect(serialized).not.toContain("210000");
  });
});
