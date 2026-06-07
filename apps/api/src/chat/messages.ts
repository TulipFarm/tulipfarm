import { randomUUID } from "node:crypto";
import type { CoreMessage, TextPart, ToolCallPart, ToolResultPart } from "ai";
import type { Collection, Db } from "mongodb";
import { type PaginatedResult, paginateCollection } from "../pagination";

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

export interface MessageRepo {
  create(doc: MessageDoc): Promise<void>;
  listByConversation(
    conversationId: string,
    limit: number,
    after?: { createdAt: Date; _id: string }
  ): Promise<PaginatedResult<MessageDoc>>;
}

export class MongoMessageRepo implements MessageRepo {
  private readonly collection: Collection<MessageDoc>;

  constructor(db: Db) {
    this.collection = db.collection<MessageDoc>("messages");
  }

  async create(doc: MessageDoc): Promise<void> {
    assertValidMessage(doc.role, doc.content);
    await this.collection.insertOne(doc);
  }

  listByConversation(
    conversationId: string,
    limit: number,
    after?: { createdAt: Date; _id: string }
  ): Promise<PaginatedResult<MessageDoc>> {
    return paginateCollection(this.collection, { conversationId }, limit, after);
  }
}
