import type { OimPagination } from "@tulipfarm/schema";
import { pointerSegments } from "./oim-response";

/**
 * Host-managed pagination.
 *
 * An Agent never learns a provider's cursor format. It receives an opaque continuation token and
 * hands it straight back, so a manifest can change pagination style without retraining the model.
 */

/** Argument name the host reserves on every paginated operation. */
export const PAGE_TOKEN_ARGUMENT = "page_token";

/** Property the host adds to a paginated response when more pages remain. */
export const NEXT_PAGE_TOKEN_PROPERTY = "next_page_token";

const TOKEN_VERSION = 1;

export type OimPaginationStyle = OimPagination["type"];

export class OimPaginationError extends Error {
  constructor(readonly code: "invalid_page_token" | "pagination_bound_exceeded") {
    super(code);
    this.name = "OimPaginationError";
  }
}

interface TokenPayload {
  readonly v: number;
  /** The operation that minted it. A token cannot be replayed against another Tool. */
  readonly t: string;
  readonly k: OimPaginationStyle;
  readonly c: string;
}

function encode(payload: TokenPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Decodes a continuation token, refusing one minted for a different operation.
 *
 * The token is deliberately unsigned: its only content is a provider cursor, and the request it
 * resumes is rebuilt from the compiled binding, so a forged one can at most send a bad cursor to
 * the same endpoint the Agent was already authorized to call. The `link` style is the exception —
 * there the cursor *is* a URL — which is why {@link nextRequestUrl} re-checks its origin.
 */
export function decodePageToken(token: string, toolId: string): TokenPayload {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new OimPaginationError("invalid_page_token");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new OimPaginationError("invalid_page_token");
  }
  const { v, t, k, c } = payload as Record<string, unknown>;
  if (v !== TOKEN_VERSION || t !== toolId || typeof k !== "string" || typeof c !== "string") {
    throw new OimPaginationError("invalid_page_token");
  }
  return { v, t, k: k as OimPaginationStyle, c };
}

/** Reads a JSON Pointer, returning undefined rather than throwing on any unresolvable path. */
export function readPointer(value: unknown, pointer: string): unknown {
  let current = value;
  for (const segment of pointerSegments(pointer)) {
    if (current === null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else {
      if (!Object.hasOwn(current, segment)) return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

/** Extracts the `rel="next"` target from an RFC 8288 `Link` header. */
export function parseNextLink(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  for (const entry of header.split(",")) {
    const target = /<([^>]*)>/.exec(entry)?.[1];
    if (target !== undefined && /;\s*rel\s*=\s*"?next"?/i.test(entry)) return target.trim();
  }
  return undefined;
}

export interface PageContext {
  readonly toolId: string;
  readonly pagination: OimPagination;
  /** Origin the operation is compiled against. A `link` target outside it is refused. */
  readonly baseUrl: string;
  /** The token this page was fetched with, so `page` style knows where it is. */
  readonly currentToken?: string;
}

/** Mints the token for the page after this one, or undefined when the provider says it is last. */
export function nextPageToken(
  context: PageContext,
  body: unknown,
  headers: Readonly<Record<string, string>>
): string | undefined {
  const { pagination, toolId } = context;
  const mint = (cursor: string): string =>
    encode({ v: TOKEN_VERSION, t: toolId, k: pagination.type, c: cursor });

  if (pagination.type === "link") {
    const target = parseNextLink(headers[(pagination.header ?? "link").toLowerCase()]);
    if (target === undefined || !sameOrigin(target, context.baseUrl)) return undefined;
    return mint(target);
  }
  if (pagination.type === "page") {
    const start = pagination.start ?? 1;
    const current =
      context.currentToken === undefined
        ? start
        : Number(decodePageToken(context.currentToken, toolId).c);
    if (!Number.isFinite(current)) return undefined;
    // A page-number provider has no "last page" signal, so an empty page is the only honest stop.
    return isEmptyPage(body, pagination.itemsPath) ? undefined : mint(String(current + 1));
  }
  const cursor = readPointer(body, pagination.responsePath);
  const next =
    typeof cursor === "string" && cursor.length > 0
      ? cursor
      : typeof cursor === "number" && Number.isFinite(cursor)
        ? String(cursor)
        : undefined;
  if (next === undefined) return undefined;
  // Some providers echo the cursor they were given on the last page instead of omitting it. Minting
  // it again would hand the caller a token that fetches the same page forever, and the page cap
  // would be the only thing that ever stopped it.
  if (context.currentToken !== undefined) {
    const current = decodePageToken(context.currentToken, toolId).c;
    if (current === next) return undefined;
  }
  return mint(next);
}

function isEmptyPage(body: unknown, itemsPath: string | undefined): boolean {
  const items = itemsPath === undefined ? body : readPointer(body, itemsPath);
  return Array.isArray(items) ? items.length === 0 : items === undefined;
}

function sameOrigin(candidate: string, base: string): boolean {
  try {
    const target = new URL(candidate);
    return target.protocol === "https:" && target.origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/**
 * Turns a continuation token into the request change that fetches it.
 *
 * A `link` token becomes an absolute URL, a `body_cursor` token a write into the request body,
 * and every other style a request parameter the compiled binding already declares.
 */
export function resumeFromToken(
  context: PageContext,
  token: string
):
  | { readonly url: string }
  | { readonly parameter: string; readonly value: string }
  | { readonly bodyPointer: string; readonly value: string } {
  const { pagination } = context;
  const payload = decodePageToken(token, context.toolId);
  if (payload.k !== pagination.type) throw new OimPaginationError("invalid_page_token");
  if (pagination.type === "link") {
    // Re-checked on resume, not just on mint: the token round-trips through the model, so trusting
    // the origin proved at mint time would let a rewritten token retarget the credential.
    if (!sameOrigin(payload.c, context.baseUrl)) throw new OimPaginationError("invalid_page_token");
    return { url: payload.c };
  }
  if (pagination.type === "body_cursor") {
    return { bodyPointer: pagination.requestPointer, value: payload.c };
  }
  return { parameter: pagination.requestParameter, value: payload.c };
}

/** Explicit ceilings a host iterator stops at, so a Routine cannot walk a provider forever. */
export interface OimPaginationBounds {
  readonly maxPages: number;
  readonly maxItems: number;
  readonly maxBytes: number;
  readonly maxDurationMs: number;
}

export const DEFAULT_OIM_PAGINATION_BOUNDS: OimPaginationBounds = {
  maxPages: 20,
  maxItems: 1_000,
  maxBytes: 4 * 1024 * 1024,
  maxDurationMs: 60_000,
};

export interface OimPaginationProgress {
  pages: number;
  items: number;
  bytes: number;
  readonly startedAt: number;
}

export function newProgress(now = Date.now()): OimPaginationProgress {
  return { pages: 0, items: 0, bytes: 0, startedAt: now };
}

/**
 * Records one fetched page and reports whether the iterator may fetch another.
 *
 * Bounds are checked after recording rather than before, so a caller always keeps the page it
 * already paid for and stops cleanly with a continuation token instead of discarding work.
 */
export function recordPage(
  progress: OimPaginationProgress,
  body: unknown,
  itemsPath: string | undefined,
  bounds: OimPaginationBounds = DEFAULT_OIM_PAGINATION_BOUNDS,
  now = Date.now()
): boolean {
  const items = itemsPath === undefined ? body : readPointer(body, itemsPath);
  progress.pages += 1;
  progress.items += Array.isArray(items) ? items.length : 0;
  progress.bytes += Buffer.byteLength(JSON.stringify(body ?? null), "utf8");
  return (
    progress.pages < bounds.maxPages &&
    progress.items < bounds.maxItems &&
    progress.bytes < bounds.maxBytes &&
    now - progress.startedAt < bounds.maxDurationMs
  );
}
