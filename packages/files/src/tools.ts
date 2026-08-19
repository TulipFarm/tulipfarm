import { ajv } from "@tulipfarm/schema";
import { type ApiToolDefinition, defineApiTool, err, ok } from "@tulipfarm/tool-host";
import { extractText, isExtractableMediaType } from "./extract";
import {
  DEFAULT_FILE_LIST_LIMIT,
  MAX_FILE_BYTES,
  MAX_FILE_LIST_LIMIT,
  MAX_FILE_READ_CHARS,
} from "./limits";
import { MAX_RENDER_INPUT_CHARS, RENDER_FORMATS, RenderError, type RenderFormat } from "./render";
import type { FileRecord } from "./repo";
import { FileError, type FileService } from "./service";

/**
 * What the File-reading Tools act as.
 *
 * `principalId` is the calling person, never the Agent: an Agent's reach into the library is
 * exactly its caller's, so a File the person could not open stays closed however the Agent asks.
 */
export interface FileToolContext {
  readonly businessId: string;
  readonly principalId: string;
  readonly service: Pick<
    FileService,
    "read" | "content" | "list" | "listSharedWithMe" | "generate"
  >;
}

const GUIDANCE =
  "Files a person attached are sent to you only on the Turn they attached them, so a document " +
  "from an earlier Turn is not in front of you any more. Re-read it here instead of asking the " +
  "person to attach it again. You see exactly the Files that person can see.";

const LIST_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    scope: {
      type: "string",
      enum: ["mine", "shared", "all"],
      description:
        "'mine' for Files the person owns, 'shared' for Files shared with them, 'all' for both. Defaults to 'all'.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_FILE_LIST_LIMIT,
      description: `How many Files to return. Defaults to ${DEFAULT_FILE_LIST_LIMIT}.`,
    },
  },
};

const READ_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["fileId"],
  properties: {
    fileId: {
      type: "string",
      minLength: 1,
      description: "The id of the File to read, as reported by file_list or an earlier attachment.",
    },
  },
};

const CREATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["filename", "format", "content"],
  properties: {
    filename: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description: "What to call the File. The correct extension is added if you leave it off.",
    },
    format: {
      type: "string",
      enum: [...RENDER_FORMATS],
      description:
        "'pdf' renders your Markdown into a paginated document. 'markdown', 'text' and 'csv' store what you wrote, unchanged.",
    },
    content: {
      type: "string",
      minLength: 1,
      maxLength: MAX_RENDER_INPUT_CHARS,
      description:
        "The document body. Markdown when format is 'pdf' — headings, lists, tables, code and emphasis all render.",
    },
    title: {
      type: "string",
      maxLength: 200,
      description: "Document title, used as the PDF's metadata title and its opening heading.",
    },
  },
};

const validateList = ajv.compile(LIST_SCHEMA);
const validateRead = ajv.compile(READ_SCHEMA);
const validateCreate = ajv.compile(CREATE_SCHEMA);

function firstError(errors: typeof validateList.errors): string {
  const problem = errors?.[0];
  if (!problem) return "invalid arguments";
  return `${problem.instancePath || "(root)"} ${problem.message ?? "is invalid"}`.trim();
}

function fileTarget(args: unknown): { type: string; id: string }[] {
  const value = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const fileId = value.fileId;
  return typeof fileId === "string" && fileId.length > 0
    ? [{ type: "platform.file", id: fileId }]
    : [];
}

function describe(file: FileRecord, source: "mine" | "shared"): Record<string, unknown> {
  return {
    fileId: file.id,
    filename: file.filename,
    mediaType: file.mediaType,
    sizeBytes: file.sizeBytes,
    origin: file.origin,
    source,
    createdAt: file.createdAt.toISOString(),
  };
}

/**
 * Reads a File's bytes, stopping once enough have arrived to fill the character cap.
 *
 * Bounded by bytes rather than by characters because the cap has to bind before decoding: a File
 * is up to 25 MiB and buffering all of it to then discard 99% of it is the exhaustion the cap
 * exists to prevent. Four bytes per character is UTF-8's worst case, so this can only ever
 * over-read, never truncate something the cap would have kept.
 */
async function readCapped(body: AsyncIterable<Uint8Array>, ceiling: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    total += chunk.length;
    if (total >= ceiling) break;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export const fileListTool = defineApiTool<FileToolContext>({
  name: "file_list",
  description: `List the Files you are allowed to see — the ones the person owns and the ones shared with them. Returns metadata only; use file_read to get content. ${GUIDANCE}`,
  tier: "platform",
  mutating: false,
  inputSchema: LIST_SCHEMA,
  authorization: {
    action: "file.list",
    resources: ["platform.file"],
    dataClasses: ["operational"],
  },
  handler: async (args, ctx) => {
    if (!validateList(args)) return err("validation_error", firstError(validateList.errors));
    const { scope = "all", limit = DEFAULT_FILE_LIST_LIMIT } = args as {
      scope?: "mine" | "shared" | "all";
      limit?: number;
    };

    const wantsOwned = scope !== "shared";
    const wantsShared = scope !== "mine";
    const [owned, shared] = await Promise.all([
      wantsOwned ? ctx.service.list(ctx.businessId, ctx.principalId, limit) : [],
      wantsShared
        ? ctx.service
            .listSharedWithMe(ctx.businessId, ctx.principalId, limit)
            .then((page) => page.files)
        : [],
    ]);

    const files = [
      ...owned.map((file) => describe(file, "mine")),
      ...shared.map((file) => describe(file, "shared")),
    ].slice(0, limit);

    return ok({ scope, files, count: files.length, limit });
  },
});

export const fileReadTool = defineApiTool<FileToolContext>({
  name: "file_read",
  description:
    "Read one File by id. A text File comes back as content, capped at " +
    `${MAX_FILE_READ_CHARS} characters. An image or a PDF cannot be returned as text, so it is ` +
    "attached to this Turn instead and you will see the document itself on your next step — " +
    `answer from it then. ${GUIDANCE}`,
  tier: "platform",
  mutating: false,
  inputSchema: READ_SCHEMA,
  authorization: {
    action: "file.read",
    resources: ["platform.file"],
    targets: fileTarget,
    dataClasses: ["operational"],
  },
  handler: async (args, ctx) => {
    if (!validateRead(args)) return err("validation_error", firstError(validateRead.errors));
    const { fileId } = args as { fileId: string };

    let file: FileRecord;
    try {
      // The authorization gate, and the only one: a File the caller cannot read answers exactly
      // as a File that does not exist, so naming an id proves nothing about it either way.
      file = await ctx.service.read(ctx.businessId, fileId, ctx.principalId);
    } catch (error) {
      if (error instanceof FileError) return err("not_found", `file ${fileId} is not available`);
      throw error;
    }

    const identity = {
      fileId: file.id,
      filename: file.filename,
      mediaType: file.mediaType,
      sizeBytes: file.sizeBytes,
    };
    const attached = {
      ...identity,
      kind: "attached",
      attached: true,
      note: "This File is attached to the Turn; you will see it on your next step.",
    };

    if (!isExtractableMediaType(file.mediaType)) return ok(attached);

    // A PDF is only worth reading whole because its cross-reference table is at the end; a
    // text File is not, so it keeps the smaller ceiling it always had.
    const ceiling = file.mediaType === "application/pdf" ? MAX_FILE_BYTES : MAX_FILE_READ_CHARS * 4;
    const { body } = await ctx.service.content(ctx.businessId, fileId, ctx.principalId);
    const extracted = await extractText(file.mediaType, await readCapped(body, ceiling), {
      maxChars: MAX_FILE_READ_CHARS,
    });

    // A scan carries no text layer, so falling back to the attachment is what lets the model see
    // the pages instead of being told the document is empty.
    if (extracted.kind === "refused") return ok(attached);

    return ok({
      ...identity,
      kind: "text",
      text: extracted.text,
      truncated: extracted.truncated,
      maxChars: MAX_FILE_READ_CHARS,
    });
  },
});

export const fileCreateTool = defineApiTool<FileToolContext>({
  name: "file_create",
  description:
    "Write a document the person can open, download and forward — not another chat message. " +
    "Use this whenever you are asked for a report, a summary, an export or 'a PDF'. Write the " +
    "body as Markdown and pick 'pdf' to have it rendered; pick 'markdown', 'text' or 'csv' to " +
    "store exactly what you wrote. The File lands in the person's library and you get its id " +
    "back — say what you made and what is in it, do not repeat the whole document in your reply.",
  tier: "platform",
  mutating: true,
  inputSchema: CREATE_SCHEMA,
  authorization: {
    action: "file.create",
    resources: ["platform.file"],
    dataClasses: ["operational"],
  },
  handler: async (args, ctx) => {
    if (!validateCreate(args)) return err("validation_error", firstError(validateCreate.errors));
    const { filename, format, content, title } = args as {
      filename: string;
      format: RenderFormat;
      content: string;
      title?: string;
    };

    let file: FileRecord;
    try {
      file = await ctx.service.generate({
        businessId: ctx.businessId,
        filename,
        format,
        content,
        ...(title === undefined ? {} : { title }),
        readableBy: { kind: "user", id: ctx.principalId },
      });
    } catch (error) {
      // A refused render is the Agent's to fix — it wrote something too long or too deep — so it
      // comes back as a validation error it can act on rather than an internal one it cannot.
      if (error instanceof RenderError) return err("validation_error", error.message);
      if (error instanceof FileError) return err("oversize_value", error.message);
      throw error;
    }

    return ok({
      fileId: file.id,
      filename: file.filename,
      mediaType: file.mediaType,
      sizeBytes: file.sizeBytes,
      origin: file.origin,
      createdAt: file.createdAt.toISOString(),
    });
  },
});

/**
 * The File Tools an Agent may hold.
 *
 * List, read and create. Sharing and deletion are absent by construction rather than by
 * permission: both change who can reach a File that already exists, and that decision stays with
 * the person who owns it. Creating is different — it makes a File nobody had a claim on yet, and
 * the only person given a claim is the caller. A ratchet in
 * `apps/api/src/tools/contract-coverage.test.ts` keeps it that way.
 */
export const FILE_TOOLS: ApiToolDefinition<FileToolContext>[] = [
  fileListTool,
  fileReadTool,
  fileCreateTool,
];
