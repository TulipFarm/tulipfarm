import { randomUUID } from "node:crypto";
import type { CoreMessage, TextPart, ToolCallPart, ToolResultPart } from "ai";
import type { Queryable } from "../db";
import { type PaginatedResult, toPage } from "../pagination";

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool-result"; toolCallId: string; toolName: string; result: unknown };

export type MessageRole = "system" | "user" | "assistant" | "tool";

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

/**
 * Enforces the per-role content constraints from the design spec (§3) so that no
 * document that cannot round-trip to a `CoreMessage` is ever persisted.
 */
export function assertValidMessage(role: MessageRole, content: string | MessagePart[]): void {
  const isString = typeof content === "string";

  if (role === "system" || role === "user") {
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

  // role === "tool"
  if (isString) {
    throw new InvalidMessageError("tool message content must be an array of tool-result parts");
  }
  if (content.length === 0) {
    throw new InvalidMessageError("tool message parts array cannot be empty");
  }
  for (const part of content) {
    if (part.type !== "tool-result") {
      throw new InvalidMessageError(`tool message cannot contain a "${part.type}" part`);
    }
  }
}

/**
 * Maps a stored `MessageDoc` to the AI SDK's `CoreMessage`, resolving the SDK's
 * per-role content rules (spec §6.1). Relies on the write-time validation above
 * so it never meets an illegal state.
 */
export function toCoreMessage(doc: MessageDoc): CoreMessage {
  const { role, content } = doc;

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
          args: part.args,
        });
      }
    }
    return { role: "assistant", content: parts };
  }

  // role === "tool"
  const toolParts: ToolResultPart[] = [];
  if (typeof content !== "string") {
    for (const part of content) {
      if (part.type === "tool-result") {
        toolParts.push({
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          result: part.result,
        });
      }
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

export function fromAssistantText(conversationId: string, text: string): MessageDoc {
  return {
    _id: randomUUID(),
    conversationId,
    role: "assistant",
    content: text,
    createdAt: new Date(),
  };
}

/** Build an assistant turn that called tools — `parts` are text and/or tool-call parts. */
export function fromAssistantParts(conversationId: string, parts: MessagePart[]): MessageDoc {
  return {
    _id: randomUUID(),
    conversationId,
    role: "assistant",
    content: parts,
    createdAt: new Date(),
  };
}

/** Build the tool turn carrying the results of an assistant's tool calls. */
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
  const doc: MessageDoc = {
    _id: row.id as string,
    conversationId: row.conversation_id as string,
    role: row.role as MessageRole,
    content: row.content as string | MessagePart[],
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
