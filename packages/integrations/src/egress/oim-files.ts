import type { OimMultipartPart } from "@tulipfarm/schema";
import type { ToolAdapterRequest } from "@tulipfarm/tool-broker";

interface OimFile {
  readonly id: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
}

export interface OimMultipartBinding {
  readonly multipart?: readonly OimMultipartPart[];
}

export class OimMultipartFileInputError extends Error {
  readonly name = "OimMultipartFileInputError";

  constructor(readonly pointer: string) {
    super(`invalid multipart File ID at ${pointer}`);
  }
}

export interface OimFileReadAuthorizationRequest {
  readonly request: ToolAdapterRequest;
  /** Sorted, unique IDs extracted only from the compiled multipart File pointers. */
  readonly fileIds: readonly string[];
}

export interface OimFileReadAuthorizationPort {
  assertAuthorized(input: OimFileReadAuthorizationRequest): Promise<void>;
}

export interface OimFilePort {
  content(input: {
    readonly businessId: string;
    readonly fileId: string;
    readonly principalId: string;
  }): Promise<{ readonly file: OimFile; readonly body: AsyncIterable<Uint8Array> }>;
  store(input: {
    readonly businessId: string;
    readonly ownerPrincipalId: string;
    readonly filename: string;
    readonly claimedMediaType: string;
    readonly declaredBytes: number;
    readonly body: AsyncIterable<Uint8Array>;
  }): Promise<OimFile>;
}

const UNSAFE_POINTER_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_FILE_ID_LENGTH = 128;

function decodePointerSegment(segment: string): string | undefined {
  if (/~(?:[^01]|$)/.test(segment)) return undefined;
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

export function oimMultipartPointerValue(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  if (!pointer.startsWith("/")) return undefined;

  let current = value;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = decodePointerSegment(rawSegment);
    if (segment === undefined || UNSAFE_POINTER_SEGMENTS.has(segment)) return undefined;
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(segment)) return undefined;
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || !Object.hasOwn(current, index)) return undefined;
      current = current[index];
      continue;
    }
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function validFileId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_FILE_ID_LENGTH &&
    value.trim() === value
  );
}

/** Returns the exact declared multipart File targets, independent of argument property names. */
export function extractOimMultipartFileIds(
  binding: OimMultipartBinding,
  argumentsValue: unknown
): readonly string[] {
  const fileParts = binding.multipart?.filter((part) => part.kind === "file") ?? [];
  if (fileParts.length === 0) return [];
  if (
    argumentsValue === null ||
    typeof argumentsValue !== "object" ||
    Array.isArray(argumentsValue)
  ) {
    throw new OimMultipartFileInputError("/body");
  }
  const body = (argumentsValue as Record<string, unknown>).body;
  const ids = new Set<string>();
  for (const part of fileParts) {
    const value = oimMultipartPointerValue(body, part.pointer);
    if (!validFileId(value)) throw new OimMultipartFileInputError(part.pointer);
    ids.add(value);
  }
  return Object.freeze([...ids].sort());
}
