import { describe, expect, it } from "vitest";
import { BUSINESS_PRINCIPAL_ID, MAX_FILE_READ_CHARS } from "./limits";
import { MAX_RENDER_INPUT_CHARS, RenderError } from "./render";
import type { FileRecord } from "./repo";
import { FileError, type GenerateRequest } from "./service";
import {
  FILE_TOOLS,
  type FileToolContext,
  fileCreateTool,
  fileListTool,
  fileReadTool,
} from "./tools";

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
    generated: [] as GenerateRequest[],
    generate: async function (this: { generated: GenerateRequest[] }, request: GenerateRequest) {
      this.generated.push(request);
      return record({
        id: "cccccccc-1111-4111-8111-111111111111",
        ownerPrincipalId: BUSINESS_PRINCIPAL_ID,
        filename: `${request.filename}.pdf`,
        mediaType: "application/pdf",
        origin: "generated",
      });
    },
  };
}

function context(
  service: FileToolContext["service"],
  principalId = ME,
  agentId?: string
): FileToolContext {
  return {
    businessId: BUSINESS,
    principalId,
    service,
    ...(agentId === undefined ? {} : { agentId }),
  };
}

function data(result: Awaited<ReturnType<typeof fileReadTool.handler>>): Record<string, unknown> {
  if (!result.success) throw new Error(`expected success, got ${result.error.code}`);
  return result.data as Record<string, unknown>;
}

describe("the File Tools an Agent holds", () => {
  it("is list, read and create, and nothing that changes who can reach an existing File", () => {
    expect(FILE_TOOLS.map((tool) => tool.name).sort()).toEqual([
      "file_create",
      "file_list",
      "file_read",
    ]);
    expect(FILE_TOOLS.filter((tool) => tool.mutating === true).map((tool) => tool.name)).toEqual([
      "file_create",
    ]);
  });

  it("says in its own description that an earlier Turn's File is no longer in front of it", () => {
    // The tokens saved by sending a File once are only saved if the Agent knows to come back for
    // it. Without this the model's most likely move is to ask the person to attach it again.
    for (const tool of [fileListTool, fileReadTool]) {
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

  it("does not let a named Agent widen what its caller may read", async () => {
    // Writing widens; reading never does. An Agent reads attachments from untrusted sources, so a
    // File the caller could not open has to stay closed however the Agent asks.
    const file = record({ id: "aaaaaaaa-1111-4111-8111-111111111111" });
    const service = library([file]);
    const result = await fileReadTool.handler({ fileId: file.id }, context(service, OTHER, "hr"));
    expect(result.success).toBe(false);
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

describe("file_create", () => {
  const args = { filename: "q3-summary", format: "pdf", content: "# Q3\n\nRevenue up." };

  it("hands the document to the service and reports the File it made", async () => {
    const service = library([]);
    const result = await fileCreateTool.handler(args, context(service));
    expect(service.generated).toEqual([
      expect.objectContaining({
        businessId: BUSINESS,
        filename: "q3-summary",
        format: "pdf",
        content: "# Q3\n\nRevenue up.",
      }),
    ]);
    expect(data(result)).toEqual(
      expect.objectContaining({ mediaType: "application/pdf", origin: "generated" })
    );
  });

  it("gives the caller read access to what it made, and nobody else", async () => {
    const service = library([]);
    await fileCreateTool.handler(args, context(service, OTHER));
    expect(service.generated[0].readableBy).toEqual({ kind: "user", id: OTHER });
  });

  it("names the Agent that wrote it, so that Agent's team can read it too", async () => {
    const service = library([]);
    await fileCreateTool.handler(args, context(service, OTHER, "agent-hr"));
    expect(service.generated[0]).toMatchObject({
      readableBy: { kind: "user", id: OTHER },
      authoredByAgentId: "agent-hr",
    });
  });

  it("names no Agent when the call is not running as one", async () => {
    const service = library([]);
    await fileCreateTool.handler(args, context(service));
    expect(service.generated[0].authoredByAgentId).toBeUndefined();
  });

  it("does not let the Agent name its own audience", async () => {
    const service = library([]);
    await fileCreateTool.handler(
      { ...args, authoredByAgentId: "agent-finance" },
      context(service, ME, "agent-hr")
    );
    // `additionalProperties: false` refuses the call rather than letting the model pick a team.
    expect(service.generated).toHaveLength(0);
  });

  it("does not let the Agent choose an owner", async () => {
    const service = library([]);
    await fileCreateTool.handler({ ...args, ownerPrincipalId: "someone-else" }, context(service));
    // `additionalProperties: false` refuses it outright rather than quietly dropping it.
    expect(service.generated).toHaveLength(0);
  });

  it("refuses a format it cannot render", async () => {
    const service = library([]);
    const result = await fileCreateTool.handler({ ...args, format: "docx" }, context(service));
    expect(result.success).toBe(false);
    expect(service.generated).toHaveLength(0);
  });

  it("refuses content past the render input cap before spending a render", async () => {
    const service = library([]);
    const result = await fileCreateTool.handler(
      { ...args, content: "x".repeat(MAX_RENDER_INPUT_CHARS + 1) },
      context(service)
    );
    expect(result.success).toBe(false);
    expect(service.generated).toHaveLength(0);
  });

  it("reports a refused render as the Agent's to fix, not as an internal failure", async () => {
    const service = {
      ...library([]),
      generate: async () => {
        throw new RenderError("too_many_pages", "render exceeded 200 pages");
      },
    };
    const result = await fileCreateTool.handler(args, context(service));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("validation_error");
    expect(result.error.message).toMatch(/200 pages/);
  });

  it("tells the Agent to describe the document rather than repeat it", () => {
    // Without this the model writes the report twice — once into the File and once into the reply
    // — which is the failure mode that makes the whole feature feel pointless.
    expect(fileCreateTool.description).toMatch(/do not repeat the whole document/i);
  });
});
