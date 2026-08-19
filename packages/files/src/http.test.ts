import { describe, expect, it } from "vitest";
import { serializeFile } from "./http";
import { decodeFileCursor, encodeFileCursor, type FileRecord } from "./repo";

function file(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: "file_1",
    businessId: "biz_1",
    ownerPrincipalId: "user_1",
    filename: "report.pdf",
    mediaType: "application/pdf",
    claimedMediaType: "application/pdf",
    knowledgeRequestedAt: null,
    sizeBytes: 12,
    blob: { key: "files/biz_1/file_1", hash: "abc" },
    origin: "uploaded",
    sourceConversationId: null,
    sourceRunId: null,
    createdAt: new Date("2025-01-02T03:04:05.000Z"),
    ...overrides,
  };
}

describe("serializeFile", () => {
  it("carries the owner and the origin, so the library can say whose it is and who made it", () => {
    const wire = serializeFile(file({ origin: "generated", ownerPrincipalId: "agent_7" }));

    expect(wire.owner).toBe("agent_7");
    expect(wire.origin).toBe("generated");
  });

  it("renames the Conversation to a Chat on the way out", () => {
    expect(serializeFile(file({ sourceConversationId: "conv_9" })).sourceChatId).toBe("conv_9");
    expect(serializeFile(file({ sourceRunId: "run_9" })).sourceRunId).toBe("run_9");
    expect(serializeFile(file()).sourceRunId).toBeNull();
    expect(serializeFile(file()).sourceChatId).toBeNull();
  });
});

describe("file cursors", () => {
  it("round-trips the sort key of the row it points at", () => {
    const row = file({ id: "file_42" });

    expect(decodeFileCursor(encodeFileCursor(row))).toEqual({
      createdAt: "2025-01-02T03:04:05.000Z",
      id: "file_42",
    });
  });

  it("is opaque, so nothing a client reads about it can become a contract", () => {
    expect(encodeFileCursor(file())).not.toContain("file_1");
  });

  it("refuses a cursor it did not issue rather than paging from nowhere", () => {
    expect(decodeFileCursor("not-a-cursor")).toBeNull();
    expect(decodeFileCursor(Buffer.from("no-separator").toString("base64url"))).toBeNull();
    expect(decodeFileCursor(Buffer.from("2025-01-01T00:00:00Z|").toString("base64url"))).toBeNull();
    expect(decodeFileCursor(Buffer.from("nonsense|file_1").toString("base64url"))).toBeNull();
  });
});
