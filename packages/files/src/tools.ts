import { ajv } from "@tulipfarm/schema";
import { type ApiToolDefinition, defineApiTool, err, ok } from "@tulipfarm/tool-host";
import {
  DEFAULT_FILE_LIST_LIMIT,
  isTextualMediaType,
  MAX_FILE_LIST_LIMIT,
  MAX_FILE_READ_CHARS,
} from "./limits";
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
  readonly service: Pick<FileService, "read" | "content" | "list" | "listSharedWithMe">;
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

const validateList = ajv.compile(LIST_SCHEMA);
const validateRead = ajv.compile(READ_SCHEMA);

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
async function readCapped(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const ceiling = MAX_FILE_READ_CHARS * 4;
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

    if (!isTextualMediaType(file.mediaType)) {
      return ok({
        fileId: file.id,
        filename: file.filename,
        mediaType: file.mediaType,
        sizeBytes: file.sizeBytes,
        kind: "attached",
        attached: true,
        note: "This File is attached to the Turn; you will see it on your next step.",
      });
    }

    const { body } = await ctx.service.content(ctx.businessId, fileId, ctx.principalId);
    const decoded = new TextDecoder().decode(await readCapped(body));
    const text = decoded.slice(0, MAX_FILE_READ_CHARS);

    return ok({
      fileId: file.id,
      filename: file.filename,
      mediaType: file.mediaType,
      sizeBytes: file.sizeBytes,
      kind: "text",
      text,
      truncated: decoded.length > text.length || file.sizeBytes > text.length,
      maxChars: MAX_FILE_READ_CHARS,
    });
  },
});

/**
 * The File Tools an Agent may hold.
 *
 * Read and list only. Sharing and deletion are absent by construction rather than by permission:
 * both change who can reach a File, and that decision stays with the person who owns it. A ratchet
 * in `apps/api/src/tools/contract-coverage.test.ts` keeps it that way.
 */
export const FILE_TOOLS: ApiToolDefinition<FileToolContext>[] = [fileListTool, fileReadTool];
