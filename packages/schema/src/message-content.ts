import { type Static, Type } from "@sinclair/typebox";

/**
 * The content of one Message, as an ordered list of parts.
 *
 * A part names a File, it never carries bytes or base64. Content that big belongs in the blob
 * store, and a transcript that inlined it would be re-sent on every iteration of the Tool loop.
 */

const TextPart = Type.Object(
  {
    type: Type.Literal("text"),
    text: Type.String(),
  },
  { additionalProperties: false }
);

const FilePart = Type.Object(
  {
    type: Type.Literal("file"),
    fileId: Type.String({ minLength: 1 }),
    mediaType: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

export const MessageContentPartSchema = Type.Union([TextPart, FilePart]);

export const MessageContentSchema = Type.Array(MessageContentPartSchema);

export type MessageContentPart = Static<typeof MessageContentPartSchema>;

export type MessageContent = readonly MessageContentPart[];

export type MessageFilePart = Static<typeof FilePart>;

export function textContent(text: string): MessageContent {
  return [{ type: "text", text }];
}

/**
 * The text a part list carries, for the readers that can only see text — token counters,
 * transcript logs, the injection guard.
 *
 * File parts contribute nothing here on purpose: a caller that needs to screen or budget for a
 * File's contents must resolve it, not read a placeholder that says nothing about the bytes.
 */
export function contentText(content: MessageContent): string {
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function contentFiles(content: MessageContent): readonly MessageFilePart[] {
  return content.filter((part) => part.type === "file");
}

/**
 * Reads content persisted before parts existed.
 *
 * Every running install has rows holding a bare JSON string, so this is a permanent read path,
 * not a migration window. Unrecognised shapes normalise to empty rather than throwing: a single
 * malformed row must not make a whole conversation unreadable.
 */
export function normalizeMessageContent(raw: unknown): MessageContent {
  if (typeof raw === "string") return textContent(raw);
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((part) => {
    const candidate = asMessageContentPart(part);
    return candidate === undefined ? [] : [candidate];
  });
}

function asMessageContentPart(value: unknown): MessageContentPart | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const part = value as Record<string, unknown>;
  if (part.type === "text" && typeof part.text === "string") {
    return { type: "text", text: part.text };
  }
  if (
    part.type === "file" &&
    typeof part.fileId === "string" &&
    typeof part.mediaType === "string" &&
    typeof part.name === "string"
  ) {
    return { type: "file", fileId: part.fileId, mediaType: part.mediaType, name: part.name };
  }
  return undefined;
}

/**
 * Projects content back to the bare string a pre-parts reader expects, or `null` when it carries
 * anything a string cannot hold.
 *
 * Rows written before parts existed, and rows a parts-aware writer filled with nothing but text,
 * are the same message; a reader that predates parts should not be able to tell them apart. A
 * `null` means the caller has to widen, because collapsing would drop a File.
 */
export function collapseToText(parts: readonly unknown[]): string | null {
  if (parts.length === 0) return null;
  const texts: string[] = [];
  for (const part of parts) {
    if (!isTextPart(part)) return null;
    texts.push(part.text);
  }
  return texts.join("\n");
}

function isTextPart(value: unknown): value is { type: "text"; text: string } {
  if (typeof value !== "object" || value === null) return false;
  const part = value as Record<string, unknown>;
  return part.type === "text" && typeof part.text === "string";
}
