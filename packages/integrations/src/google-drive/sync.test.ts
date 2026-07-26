import type { GuardrailRule } from "@tulipfarm/authz";
import { describe, expect, it } from "vitest";
import type {
  KnowledgeChunkEmission,
  KnowledgeEmissionSink,
  KnowledgeIdentityMapPort,
  KnowledgeSourceEmission,
} from "../knowledge/source";
import type { DriveApiPort, DriveChange, DriveFile, DrivePermission } from "./ports";
import { InMemoryDriveCheckpointStore } from "./ports";
import { syncDriveKnowledge } from "./sync";

const NOW = new Date("2026-07-26T12:00:00.000Z");
const now = () => NOW;

const EXTRACTION_RULES: readonly GuardrailRule[] = [
  {
    id: "extract-internal",
    effect: "allow",
    action: "knowledge.extract",
    resourceType: "knowledge_source",
    dataClass: "internal",
  },
  {
    id: "extract-restricted",
    effect: "allow",
    action: "knowledge.extract",
    resourceType: "knowledge_source",
    dataClass: "restricted",
  },
];

class RecordingSink implements KnowledgeEmissionSink {
  readonly sources: KnowledgeSourceEmission[] = [];
  readonly chunks: KnowledgeChunkEmission[] = [];
  readonly removed: string[] = [];
  failOnSourceId?: string;

  async emitSource(source: KnowledgeSourceEmission): Promise<void> {
    if (source.sourceId === this.failOnSourceId) throw new Error("sink unavailable");
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
      "alice@example.com": [{ kind: "user", id: "user-1" }],
      "hr@example.com": [{ kind: "user", id: "user-2" }],
      "hr-team@example.com": [{ kind: "role", id: "role-hr" }],
    };
    return mapping[externalSubject];
  },
};

function file(overrides: Partial<DriveFile> = {}): DriveFile {
  return {
    id: "handbook",
    name: "Employee handbook",
    mimeType: "application/vnd.google-apps.document",
    version: "3",
    ownerExternalId: "alice@example.com",
    contentHash: "a".repeat(64),
    modifiedTime: "2026-07-26T11:00:00.000Z",
    trashed: false,
    ...overrides,
  };
}

interface StubOptions {
  changes: readonly DriveChange[];
  files: Readonly<Record<string, DriveFile>>;
  permissions: Readonly<Record<string, readonly DrivePermission[] | undefined>>;
  text?: Readonly<Record<string, string>>;
}

function stubApi(options: StubOptions): DriveApiPort {
  return {
    async listChanges({ cursor }) {
      const start =
        cursor === undefined
          ? 0
          : options.changes.findIndex((change) => change.cursor === cursor) + 1;
      const changes = options.changes.slice(start);
      return { changes, nextCursor: changes.at(-1)?.cursor ?? cursor };
    },
    async getFile(fileId) {
      return options.files[fileId];
    },
    async getPermissions(fileId) {
      return options.permissions[fileId];
    },
    async exportText(fileId) {
      const text = options.text?.[fileId];
      return text === undefined ? undefined : { text, mimeType: "text/plain" };
    },
  };
}

const base = {
  businessId: "biz-1",
  integrationId: "int-drive",
  externalTenantId: "tenant-1",
  extraction: { rules: EXTRACTION_RULES },
};

describe("syncDriveKnowledge", () => {
  it("emits a snapshot ACL built from the file's mapped permissions", async () => {
    const api = stubApi({
      changes: [{ fileId: "handbook", cursor: "c1" }],
      files: { handbook: file() },
      permissions: {
        handbook: [
          { type: "user", externalSubject: "alice@example.com", role: "reader" },
          { type: "group", externalSubject: "hr-team@example.com", role: "reader" },
        ],
      },
      text: { handbook: "the handbook explains the review process" },
    });
    const sink = new RecordingSink();
    const checkpoints = new InMemoryDriveCheckpointStore();
    const result = await syncDriveKnowledge({ api, checkpoints, sink, identity, now }, base);

    expect(result.emitted).toBe(1);
    const source = sink.sources[0];
    expect(source?.sourceId).toBe("google-drive:handbook");
    expect(source?.verification).toBe("verified");
    expect(source?.accessControl).toEqual({
      mode: "snapshot",
      aclRevision: expect.any(String),
      maximumAgeSeconds: 300,
    });
    expect(source?.acl?.principals).toEqual([
      { kind: "user", id: "user-1" },
      { kind: "role", id: "role-hr" },
    ]);
    expect(sink.chunks).toHaveLength(1);
  });

  it("drops permission holders with no Tulip identity mapping instead of granting them", async () => {
    const api = stubApi({
      changes: [{ fileId: "handbook", cursor: "c1" }],
      files: { handbook: file() },
      permissions: {
        handbook: [
          { type: "user", externalSubject: "alice@example.com", role: "reader" },
          { type: "user", externalSubject: "contractor@other.example", role: "reader" },
          { type: "anyone", externalSubject: "anyone", role: "reader" },
        ],
      },
      text: { handbook: "handbook" },
    });
    const sink = new RecordingSink();
    await syncDriveKnowledge(
      { api, checkpoints: new InMemoryDriveCheckpointStore(), sink, identity, now },
      base
    );
    expect(sink.sources[0]?.acl?.principals).toEqual([{ kind: "user", id: "user-1" }]);
  });

  it("emits a private HR file as live-authorized, restricted, and readable only by HR", async () => {
    const api = stubApi({
      changes: [{ fileId: "salaries", cursor: "c1" }],
      files: {
        salaries: file({
          id: "salaries",
          name: "Salary bands 2026",
          ownerExternalId: "hr@example.com",
          classification: ["restricted"],
        }),
      },
      permissions: {
        salaries: [{ type: "user", externalSubject: "hr@example.com", role: "writer" }],
      },
      text: { salaries: "jane doe base salary 210000" },
    });
    const sink = new RecordingSink();
    await syncDriveKnowledge(
      { api, checkpoints: new InMemoryDriveCheckpointStore(), sink, identity, now },
      base
    );

    const source = sink.sources[0];
    expect(source?.classification).toEqual(["restricted"]);
    // Sensitive sources revalidate against the provider on every read; there is no cached ACL
    // that could outlive a permission change.
    expect(source?.accessControl).toEqual({ mode: "live", maximumAgeSeconds: 60 });
    expect(source?.acl).toBeUndefined();
    expect(sink.chunks[0]?.classification).toEqual(["restricted"]);
  });

  it("emits an unverifiable source, and no content, when permissions cannot be read", async () => {
    const api = stubApi({
      changes: [{ fileId: "handbook", cursor: "c1" }],
      files: { handbook: file() },
      permissions: { handbook: undefined },
      text: { handbook: "the handbook explains the review process" },
    });
    const sink = new RecordingSink();
    const result = await syncDriveKnowledge(
      { api, checkpoints: new InMemoryDriveCheckpointStore(), sink, identity, now },
      base
    );

    expect(result.unverifiable).toBe(1);
    expect(sink.sources[0]?.verification).toBe("unverifiable");
    expect(sink.chunks).toEqual([]);
  });

  it("marks a removed or trashed file deleted and drops its indexed content", async () => {
    const api = stubApi({
      changes: [
        { fileId: "gone", cursor: "c1", removed: true },
        { fileId: "trashed", cursor: "c2" },
      ],
      files: { trashed: file({ id: "trashed", trashed: true }) },
      permissions: {},
    });
    const sink = new RecordingSink();
    const result = await syncDriveKnowledge(
      { api, checkpoints: new InMemoryDriveCheckpointStore(), sink, identity, now },
      base
    );

    expect(result.deleted).toBe(2);
    expect(sink.sources.map((source) => source.status)).toEqual(["deleted", "deleted"]);
    expect(sink.removed).toEqual(["google-drive:gone", "google-drive:trashed"]);
    expect(sink.chunks).toEqual([]);
  });

  it("indexes no content when extraction is not permitted for the classification", async () => {
    const api = stubApi({
      changes: [{ fileId: "secret", cursor: "c1" }],
      files: { secret: file({ id: "secret", classification: ["confidential"] }) },
      permissions: {
        secret: [{ type: "user", externalSubject: "alice@example.com", role: "reader" }],
      },
      text: { secret: "merger terms" },
    });
    const sink = new RecordingSink();
    const result = await syncDriveKnowledge(
      { api, checkpoints: new InMemoryDriveCheckpointStore(), sink, identity, now },
      base
    );

    expect(sink.sources).toHaveLength(1);
    expect(sink.chunks).toEqual([]);
    expect(result.extractionDenied).toBe(1);
  });

  describe("durable checkpoints", () => {
    function threeChanges() {
      return stubApi({
        changes: [
          { fileId: "a", cursor: "c1" },
          { fileId: "b", cursor: "c2" },
          { fileId: "c", cursor: "c3" },
        ],
        files: {
          a: file({ id: "a" }),
          b: file({ id: "b" }),
          c: file({ id: "c" }),
        },
        permissions: {
          a: [{ type: "user", externalSubject: "alice@example.com", role: "reader" }],
          b: [{ type: "user", externalSubject: "alice@example.com", role: "reader" }],
          c: [{ type: "user", externalSubject: "alice@example.com", role: "reader" }],
        },
        text: { a: "alpha", b: "bravo", c: "charlie" },
      });
    }

    it("advances the checkpoint only past changes that fully committed", async () => {
      const api = threeChanges();
      const checkpoints = new InMemoryDriveCheckpointStore();
      const sink = new RecordingSink();
      sink.failOnSourceId = "google-drive:b";

      const result = await syncDriveKnowledge({ api, checkpoints, sink, identity, now }, base);

      expect(result.emitted).toBe(1);
      expect(result.failures).toEqual([{ code: "emit_failed" }]);
      expect((await checkpoints.load("int-drive"))?.cursor).toBe("c1");
    });

    it("resumes from the stored checkpoint without reprocessing committed changes", async () => {
      const api = threeChanges();
      const checkpoints = new InMemoryDriveCheckpointStore();
      const first = new RecordingSink();
      first.failOnSourceId = "google-drive:b";
      await syncDriveKnowledge({ api, checkpoints, sink: first, identity, now }, base);

      const second = new RecordingSink();
      const result = await syncDriveKnowledge(
        { api, checkpoints, sink: second, identity, now },
        base
      );

      expect(second.sources.map((source) => source.sourceId)).toEqual([
        "google-drive:b",
        "google-drive:c",
      ]);
      expect(result.emitted).toBe(2);
      expect((await checkpoints.load("int-drive"))?.cursor).toBe("c3");
    });

    it("is idempotent when the same checkpoint window is replayed", async () => {
      const api = threeChanges();
      const checkpoints = new InMemoryDriveCheckpointStore();
      const sink = new RecordingSink();
      await syncDriveKnowledge({ api, checkpoints, sink, identity, now }, base);
      const replay = await syncDriveKnowledge({ api, checkpoints, sink, identity, now }, base);

      expect(replay.processed).toBe(0);
      expect(sink.sources).toHaveLength(3);
    });
  });

  it("reports failures as codes only, never as file names or provider errors", async () => {
    const api: DriveApiPort = {
      async listChanges() {
        throw new Error("drive: 403 on Salary bands 2026");
      },
      async getFile() {
        return undefined;
      },
      async getPermissions() {
        return undefined;
      },
      async exportText() {
        return undefined;
      },
    };
    const result = await syncDriveKnowledge(
      {
        api,
        checkpoints: new InMemoryDriveCheckpointStore(),
        sink: new RecordingSink(),
        identity,
        now,
      },
      base
    );
    expect(result.failures).toEqual([{ code: "list_failed" }]);
    expect(JSON.stringify(result)).not.toContain("Salary");
  });
});
