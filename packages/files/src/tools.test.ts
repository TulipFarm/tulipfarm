import { describe, expect, it } from "vitest";
import { MAX_FILE_READ_CHARS } from "./limits";
import type { FileRecord } from "./repo";
import { FileError } from "./service";
import { FILE_TOOLS, type FileToolContext, fileListTool, fileReadTool } from "./tools";

const BUSINESS = "business-1";
const ME = "user-me";
const OTHER = "user-other";

function record(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    businessId: BUSINESS,
    ownerPrincipalId: ME,
    filename: "notes.txt",
    mediaType: "text/plain",
    claimedMediaType: "text/plain",
    sizeBytes: 5,
    blob: { key: "blobs/a", bucket: "files" },
    origin: "upload",
    firstConversationId: null,
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    ...overrides,
  } as FileRecord;
}

/** A File library reduced to what the Tools touch, with the same 404-for-both refusal. */
function library(files: readonly FileRecord[], bodies: Record<string, string> = {}) {
  const readable = (id: string, principalId: string): FileRecord | undefined =>
    files.find((file) => file.id === id && file.ownerPrincipalId === principalId);
  return {
    reads: [] as string[],
    read: async (_businessId: string, id: string, principalId: string) => {
      const found = readable(id, principalId);
      if (found === undefined) throw new FileError("not_found", `file ${id} does not exist`);
      return found;
    },
    content: async (_businessId: string, id: string, principalId: string) => {
      const found = readable(id, principalId);
      if (found === undefined) throw new FileError("not_found", `file ${id} does not exist`);
      const text = bodies[id] ?? "";
      return {
        file: found,
        body: (async function* () {
          yield new TextEncoder().encode(text);
        })(),
      };
    },
    list: async (_businessId: string, principalId: string, limit: number) =>
      files.filter((file) => file.ownerPrincipalId === principalId).slice(0, limit),
    listSharedWithMe: async (_businessId: string, principalId: string, limit: number) => ({
      files: files.filter((file) => file.ownerPrincipalId !== principalId).slice(0, limit),
      nextCursor: null,
    }),
  };
}

function context(service: FileToolContext["service"], principalId = ME): FileToolContext {
  return { businessId: BUSINESS, principalId, service };
}

function data(result: Awaited<ReturnType<typeof fileReadTool.handler>>): Record<string, unknown> {
  if (!result.success) throw new Error(`expected success, got ${result.error.code}`);
  return result.data as Record<string, unknown>;
}

describe("the File Tools an Agent holds", () => {
  it("is read and list, and nothing that changes who can reach a File", () => {
    expect(FILE_TOOLS.map((tool) => tool.name).sort()).toEqual(["file_list", "file_read"]);
    expect(FILE_TOOLS.every((tool) => tool.mutating === false)).toBe(true);
  });

  it("says in its own description that an earlier Turn's File is no longer in front of it", () => {
    // The tokens saved by sending a File once are only saved if the Agent knows to come back for
    // it. Without this the model's most likely move is to ask the person to attach it again.
    for (const tool of FILE_TOOLS) {
      expect(tool.description).toMatch(/earlier Turn/i);
    }
  });
});

describe("file_list", () => {
  it("lists the caller's own Files and the ones shared with them", async () => {
    const mine = record({ id: "aaaaaaaa-1111-4111-8111-111111111111" });
    const theirs = record({
      id: "bbbbbbbb-1111-4111-8111-111111111111",
      ownerPrincipalId: OTHER,
      filename: "shared.pdf",
      mediaType: "application/pdf",
    });
    const result = await fileListTool.handler({}, context(library([mine, theirs])));
    const listed = data(result).files as { fileId: string; source: string }[];
    expect(listed).toEqual([
      expect.objectContaining({ fileId: mine.id, source: "mine", filename: "notes.txt" }),
      expect.objectContaining({ fileId: theirs.id, source: "shared" }),
    ]);
  });

  it("narrows to one side when asked", async () => {
    const mine = record({ id: "aaaaaaaa-1111-4111-8111-111111111111" });
    const theirs = record({ id: "bbbbbbbb-1111-4111-8111-111111111111", ownerPrincipalId: OTHER });
    const service = library([mine, theirs]);
    const owned = data(await fileListTool.handler({ scope: "mine" }, context(service)));
    expect((owned.files as { fileId: string }[]).map((file) => file.fileId)).toEqual([mine.id]);
    const shared = data(await fileListTool.handler({ scope: "shared" }, context(service)));
    expect((shared.files as { fileId: string }[]).map((file) => file.fileId)).toEqual([theirs.id]);
  });

  it("caps how many Files one call returns", async () => {
    const files = Array.from({ length: 6 }, (_unused, index) =>
      record({ id: `aaaaaaaa-1111-4111-8111-00000000000${index}` })
    );
    const result = data(await fileListTool.handler({ limit: 2 }, context(library(files))));
    expect(result.count).toBe(2);
    expect(result.limit).toBe(2);
  });

  it("refuses a limit past the ceiling rather than serving it", async () => {
    const result = await fileListTool.handler({ limit: 5_000 }, context(library([])));
    expect(result).toEqual({
      success: false,
      error: { code: "validation_error", message: expect.stringContaining("limit") },
    });
  });

  it("never reports a File the caller cannot reach", async () => {
    const theirs = record({ id: "bbbbbbbb-1111-4111-8111-111111111111", ownerPrincipalId: OTHER });
    const service = {
      ...library([theirs]),
      listSharedWithMe: async () => ({ files: [], nextCursor: null }),
    };
    const result = data(await fileListTool.handler({}, context(service)));
    expect(result.files).toEqual([]);
  });
});

describe("file_read", () => {
  it("hands back a text File's content so a follow-up can be answered from it", async () => {
    const file = record({ id: "aaaaaaaa-1111-4111-8111-111111111111", filename: "policy.md" });
    const service = library([file], { [file.id]: "Refunds are issued within 14 days." });
    const result = data(await fileReadTool.handler({ fileId: file.id }, context(service)));
    expect(result.kind).toBe("text");
    expect(result.text).toBe("Refunds are issued within 14 days.");
    expect(result.truncated).toBe(false);
  });

  it("caps a text read and says that it did", async () => {
    const file = record({ id: "aaaaaaaa-1111-4111-8111-111111111111", sizeBytes: 100_000 });
    const service = library([file], { [file.id]: "x".repeat(MAX_FILE_READ_CHARS + 500) });
    const result = data(await fileReadTool.handler({ fileId: file.id }, context(service)));
    expect((result.text as string).length).toBe(MAX_FILE_READ_CHARS);
    expect(result.truncated).toBe(true);
    expect(result.maxChars).toBe(MAX_FILE_READ_CHARS);
  });

  it("attaches a PDF instead of pretending it is text", async () => {
    const file = record({
      id: "aaaaaaaa-1111-4111-8111-111111111111",
      filename: "audit.pdf",
      mediaType: "application/pdf",
    });
    const result = data(await fileReadTool.handler({ fileId: file.id }, context(library([file]))));
    expect(result).toMatchObject({
      kind: "attached",
      attached: true,
      mediaType: "application/pdf",
      filename: "audit.pdf",
    });
    expect(result.text).toBeUndefined();
  });

  it("attaches an image rather than decoding bytes into mojibake", async () => {
    const file = record({
      id: "aaaaaaaa-1111-4111-8111-111111111111",
      filename: "receipt.png",
      mediaType: "image/png",
    });
    const result = data(await fileReadTool.handler({ fileId: file.id }, context(library([file]))));
    expect(result.attached).toBe(true);
  });

  it("never fetches bytes for a File the caller cannot read", async () => {
    // The refusal has to come from the gate, not from the store: reading bytes first and checking
    // after is the same bug as no check at all if the check is ever skipped on an error path.
    const file = record({ id: "aaaaaaaa-1111-4111-8111-111111111111" });
    const service = library([file], { [file.id]: "secret" });
    let fetched = false;
    const watched = {
      ...service,
      content: async (...args: Parameters<typeof service.content>) => {
        fetched = true;
        return await service.content(...args);
      },
    };
    const result = await fileReadTool.handler({ fileId: file.id }, context(watched, OTHER));
    expect(result).toEqual({
      success: false,
      error: { code: "not_found", message: expect.stringContaining("not available") },
    });
    expect(fetched).toBe(false);
  });

  it("answers the same for a File that does not exist and one that is not yours", async () => {
    const file = record({ id: "aaaaaaaa-1111-4111-8111-111111111111" });
    const service = library([file]);
    const theirs = await fileReadTool.handler({ fileId: file.id }, context(service, OTHER));
    const absent = await fileReadTool.handler(
      { fileId: "cccccccc-1111-4111-8111-111111111111" },
      context(service, OTHER)
    );
    expect(theirs.success).toBe(false);
    expect(absent.success).toBe(false);
    if (theirs.success || absent.success) throw new Error("expected both to refuse");
    expect(theirs.error.code).toBe(absent.error.code);
  });

  it("refuses a call with no fileId", async () => {
    const result = await fileReadTool.handler({}, context(library([])));
    expect(result).toEqual({
      success: false,
      error: { code: "validation_error", message: expect.stringContaining("fileId") },
    });
  });
});
