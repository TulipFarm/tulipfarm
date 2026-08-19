import { randomUUID } from "node:crypto";
import { collapseToText } from "@tulipfarm/schema";
import { type PaginatedResult, toPage } from "@tulipfarm/storage";
import type { ModelMessage, TextPart, ToolCallPart, ToolResultPart } from "ai";
import type { Queryable } from "../db";

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool-result"; toolCallId: string; toolName: string; result: unknown }
  | { type: "surface"; artifactId: string; revision: number }
  | { type: "surface-unavailable"; message: "Legacy presentation unavailable" }
  | { type: "file"; fileId: string; mediaType: string; name: string }
  /**
   * An attachment the reader can no longer open, substituted for the `file` part on the way out.
   *
   * Never persisted. Messages are immutable, so a File that is destroyed cannot be edited out of
   * the transcript that named it — the reference has to survive and read as removed. It carries
   * the name from the Message rather than from the File, which is the only reason a destroyed
   * attachment can still say what it was.
   */
  | { type: "file-unavailable"; fileId: string; name: string };

/**
 * Rewrites the attachments a reader can no longer open, leaving every other part alone.
 *
 * `present` is the set of File ids the reader may currently read. Absent covers both destroyed and
 * un-shared on purpose: telling those two apart on a transcript would hand back the existence
 * oracle that the identical 404 on the Files routes exists to deny.
 */
export function withUnavailableFiles(
  docs: readonly MessageDoc[],
  present: ReadonlySet<string>
): MessageDoc[] {
  return docs.map((doc) => {
    if (typeof doc.content === "string") return doc;
    if (!doc.content.some((part) => part.type === "file" && !present.has(part.fileId))) return doc;
    return {
      ...doc,
      content: doc.content.map((part) =>
        part.type === "file" && !present.has(part.fileId)
          ? ({ type: "file-unavailable", fileId: part.fileId, name: part.name } as const)
          : part
      ),
    };
  });
}

/** Every File a page of Messages refers to, deduplicated. */
export function referencedFileIds(docs: readonly MessageDoc[]): string[] {
  const ids = new Set<string>();
  for (const doc of docs) {
    if (typeof doc.content === "string") continue;
    for (const part of doc.content) if (part.type === "file") ids.add(part.fileId);
  }
  return [...ids];
}

export type MessageRole = "system" | "user" | "assistant" | "tool" | "summary";

/** Cutoff marker on a `summary` row: the newest original turn it replaces (CTX-V1-001). */
export interface CompactionCutoff {
  createdAt: Date;
  _id: string;
}

export interface MessageDoc {
  _id: string;
  conversationId: string;
  role: MessageRole;
  content: string | MessagePart[];
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export class InvalidMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMessageError";
  }
}

/** Enforces per-role content constraints before persisting MessageDoc rows. */
export function assertValidMessage(role: MessageRole, content: string | MessagePart[]): void {
  const isString = typeof content === "string";

  if (role === "system" || role === "user" || role === "summary") {
    if (!isString) {
      throw new InvalidMessageError(`${role} message content must be a string`);
    }
    return;
  }

  if (role === "assistant") {
    if (isString) return;
    if (content.length === 0) {
      throw new InvalidMessageError("assistant message parts array cannot be empty");
    }
    for (const part of content) {
      if (part.type !== "text" && part.type !== "tool-call") {
        throw new InvalidMessageError(`assistant message cannot contain a "${part.type}" part`);
      }
    }
    return;
  }

  if (isString) {
    throw new InvalidMessageError("tool message content must be an array of tool-result parts");
  }
  if (content.length === 0) {
    throw new InvalidMessageError("tool message parts array cannot be empty");
  }
  for (const part of content) {
    if (
      part.type !== "tool-result" &&
      part.type !== "surface" &&
      part.type !== "surface-unavailable"
    ) {
      throw new InvalidMessageError(`tool message cannot contain a "${part.type}" part`);
    }
  }
}

export function toModelMessage(doc: MessageDoc): ModelMessage {
  const { role, content } = doc;

  // A `summary` row is a compaction artifact (CTX-V1-001); it enters the prompt as a
  // system message carrying the summary of the oldest turns it replaced.
  if (role === "summary") {
    return { role: "system", content: typeof content === "string" ? content : "" };
  }

  if (role === "system" || role === "user") {
    const text = typeof content === "string" ? content : "";
    return { role, content: text };
  }

  if (role === "assistant") {
    if (typeof content === "string") {
      return { role: "assistant", content };
    }
    const parts: Array<TextPart | ToolCallPart> = [];
    for (const part of content) {
      if (part.type === "text") {
        parts.push({ type: "text", text: part.text });
      } else if (part.type === "tool-call") {
        parts.push({
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.args,
        });
      }
    }
    return { role: "assistant", content: parts };
  }

  const toolParts: ToolResultPart[] = [];
  if (typeof content !== "string") {
    for (const part of content) {
      if (part.type === "tool-result") {
        toolParts.push({
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: { type: "json" as const, value: part.result as import("ai").JSONValue },
        });
      }
      // Presentation references are durable UI Artifacts, not model-input Tool results.
    }
  }
  return { role: "tool", content: toolParts };
}

export function fromUserText(conversationId: string, text: string): MessageDoc {
  return {
    _id: randomUUID(),
    conversationId,
    role: "user",
    content: text,
    createdAt: new Date(),
  };
}

// Optional client-known id lets feedback attach to the just-streamed message.
export function fromAssistantText(conversationId: string, text: string, id?: string): MessageDoc {
  return {
    _id: id ?? randomUUID(),
    conversationId,
    role: "assistant",
    content: text,
    createdAt: new Date(),
  };
}

/** Summary rows sort at the cutoff turn and record the newest compacted turn they cover. */
export function fromSummary(
  conversationId: string,
  text: string,
  compactedThrough: CompactionCutoff
): MessageDoc {
  return {
    _id: randomUUID(),
    conversationId,
    role: "summary",
    content: text,
    metadata: { compactedThrough },
    createdAt: compactedThrough.createdAt,
  };
}

export function fromAssistantParts(conversationId: string, parts: MessagePart[]): MessageDoc {
  return {
    _id: randomUUID(),
    conversationId,
    role: "assistant",
    content: parts,
    createdAt: new Date(),
  };
}

export function fromToolResult(conversationId: string, parts: MessagePart[]): MessageDoc {
  return {
    _id: randomUUID(),
    conversationId,
    role: "tool",
    content: parts,
    createdAt: new Date(),
  };
}

export interface MessageRepo {
  create(doc: MessageDoc): Promise<void>;
  listByConversation(
    conversationId: string,
    limit: number,
    after?: { createdAt: Date; _id: string }
  ): Promise<PaginatedResult<MessageDoc>>;
}

function rowToMessage(row: Record<string, unknown>): MessageDoc {
  const raw = row.content as string | Array<Record<string, unknown>>;
  // The Turn store writes this table as `MessageContent`, so a text-only row it wrote has to reach
  // the wire as the string every reader downstream of here still expects.
  const rawContent = typeof raw === "string" ? raw : (collapseToText(raw) ?? raw);
  const content =
    typeof rawContent === "string"
      ? rawContent
      : rawContent.map((part) =>
          typeof part.html === "string"
            ? ({
                type: "surface-unavailable",
                message: "Legacy presentation unavailable",
              } as const)
            : (part as MessagePart)
        );
  const doc: MessageDoc = {
    _id: row.id as string,
    conversationId: row.conversation_id as string,
    role: row.role as MessageRole,
    content,
    createdAt: row.created_at as Date,
  };
  if (row.metadata != null) {
    doc.metadata = row.metadata as Record<string, unknown>;
  }
  return doc;
}

export class PgMessageRepo implements MessageRepo {
  constructor(private readonly q: Queryable) {}

  async create(doc: MessageDoc): Promise<void> {
    assertValidMessage(doc.role, doc.content);
    await this.q.query(
      "INSERT INTO messages (id, conversation_id, role, content, metadata, created_at) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)",
      [
        doc._id,
        doc.conversationId,
        doc.role,
        // jsonb: a string becomes a JSON string ("x"), an array becomes a JSON array.
        JSON.stringify(doc.content),
        doc.metadata == null ? null : JSON.stringify(doc.metadata),
        doc.createdAt,
      ]
    );
  }

  async listByConversation(
    conversationId: string,
    limit: number,
    after?: { createdAt: Date; _id: string }
  ): Promise<PaginatedResult<MessageDoc>> {
    const { rows } = after
      ? await this.q.query(
          "SELECT * FROM messages WHERE conversation_id = $1 AND (created_at, id) > ($2, $3) ORDER BY created_at, id LIMIT $4",
          [conversationId, after.createdAt, after._id, limit + 1]
        )
      : await this.q.query(
          "SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at, id LIMIT $2",
          [conversationId, limit + 1]
        );
    return toPage(rows.map(rowToMessage), limit);
  }
}
