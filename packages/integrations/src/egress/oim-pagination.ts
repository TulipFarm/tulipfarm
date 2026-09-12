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

/** Property that carries a provider's top-level array inside a paginated result envelope. */
export const PAGINATED_ITEMS_PROPERTY = "items";

/** Describes the stable host envelope used when a paginated provider returns a top-level array. */
export function withPaginationOutputSchema(
  declared: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  if (declared.type === "array") {
    return {
      type: "object",
      properties: {
        [PAGINATED_ITEMS_PROPERTY]: declared,
        [NEXT_PAGE_TOKEN_PROPERTY]: { type: "string" },
      },
      required: [PAGINATED_ITEMS_PROPERTY],
      additionalProperties: false,
    };
  }
  return {
    ...declared,
    properties: {
      ...((declared.properties as Record<string, unknown>) ?? {}),
      [NEXT_PAGE_TOKEN_PROPERTY]: { type: "string" },
    },
  };
}

const STATE_VERSION = 3;
const MAX_CURSOR_LENGTH = 2_048;
const MAX_TOKEN_LENGTH = 4_096;

export type OimPaginationStyle = OimPagination["type"];

export class OimPaginationError extends Error {
  constructor(
    readonly code: "invalid_page_token" | "pagination_bound_exceeded" | "pagination_codec_failed"
  ) {
    super(code);
    this.name = "OimPaginationError";
  }
}

export interface OimContinuationState {
  readonly version: 3;
  readonly toolId: string;
  /** Hash of the compiled operation, installation configuration, and caller identity. */
  readonly scope: string;
  readonly style: OimPaginationStyle;
  readonly cursor: string;
  readonly progress: {
    readonly pages: number;
    readonly items: number;
    readonly bytes: number;
    readonly startedAtMs: number;
  };
}

/**
 * Host-owned confidentiality and integrity boundary for continuation state.
 *
 * Production implementations must use authenticated encryption with deployment-managed durable
 * keys, or durable opaque handles whose state cannot be read or changed by the caller. `unseal`
 * must resolve the same state on retry for the token lifetime; the runtime preserves the sealed
 * counters on replay and independently enforces expiry.
 */
export interface OimContinuationCodec {
  seal(state: OimContinuationState): Promise<string>;
  unseal(
    token: string,
    expected: Pick<OimContinuationState, "toolId" | "scope" | "style">
  ): Promise<unknown>;
}

export interface OimPaginationRuntime {
  /** Must remain compatible across processes and restarts for at least the pagination lifetime. */
  readonly codec: OimContinuationCodec;
  /** Host clock used both before dispatch and after each received page. */
  readonly now: () => number;
}

export type OimPaginationResume =
  | { readonly url: string }
  | { readonly parameter: string; readonly value: string }
  | { readonly bodyPointer: string; readonly value: string };

export interface OimPaginationSession {
  readonly progress: OimPaginationProgress;
  readonly previousCursor?: string;
  readonly resume?: OimPaginationResume;
}

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function runtimeNow(runtime: OimPaginationRuntime): number {
  const now = runtime.now();
  if (!validCount(now)) throw new OimPaginationError("pagination_codec_failed");
  return now;
}

/** Opens and validates authenticated continuation state for this exact compiled operation. */
export async function decodePageToken(
  token: string,
  context: PageContext,
  runtime: OimPaginationRuntime
): Promise<OimContinuationState> {
  if (token.length > MAX_TOKEN_LENGTH) throw new OimPaginationError("invalid_page_token");
  let state: unknown;
  try {
    state = await runtime.codec.unseal(token, {
      toolId: context.toolId,
      scope: context.scope,
      style: context.pagination.type,
    });
  } catch {
    throw new OimPaginationError("invalid_page_token");
  }
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    throw new OimPaginationError("invalid_page_token");
  }
  const { version, toolId, scope, style, cursor, progress } = state as Record<string, unknown>;
  if (
    version !== STATE_VERSION ||
    toolId !== context.toolId ||
    scope !== context.scope ||
    style !== context.pagination.type ||
    typeof cursor !== "string" ||
    cursor.length === 0 ||
    cursor.length > MAX_CURSOR_LENGTH ||
    progress === null ||
    typeof progress !== "object" ||
    Array.isArray(progress)
  ) {
    throw new OimPaginationError("invalid_page_token");
  }
  if (
    style === "page" &&
    (!Number.isSafeInteger(Number(cursor)) ||
      Number(cursor) < 0 ||
      String(Number(cursor)) !== cursor)
  ) {
    throw new OimPaginationError("invalid_page_token");
  }
  const { pages, items, bytes, startedAtMs } = progress as Record<string, unknown>;
  if (
    !validCount(pages) ||
    Number(pages) < 1 ||
    !validCount(items) ||
    !validCount(bytes) ||
    !validCount(startedAtMs)
  ) {
    throw new OimPaginationError("invalid_page_token");
  }
  const now = runtimeNow(runtime);
  const bounds = context.bounds ?? DEFAULT_OIM_PAGINATION_BOUNDS;
  if (now < Number(startedAtMs)) throw new OimPaginationError("invalid_page_token");
  if (
    Number(pages) >= bounds.maxPages ||
    Number(items) >= bounds.maxItems ||
    Number(bytes) >= bounds.maxBytes ||
    now - Number(startedAtMs) >= bounds.maxDurationMs
  ) {
    throw new OimPaginationError("pagination_bound_exceeded");
  }
  return {
    version: STATE_VERSION,
    toolId,
    scope,
    style: style as OimPaginationStyle,
    cursor,
    progress: {
      pages: Number(pages),
      items: Number(items),
      bytes: Number(bytes),
      startedAtMs: Number(startedAtMs),
    },
  };
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
  readonly scope: string;
  readonly pagination: OimPagination;
  /** Origin the operation is compiled against. A `link` target outside it is refused. */
  readonly baseUrl: string;
  readonly bounds?: OimPaginationBounds;
}

/** Prepares a first page or securely resumes one before any provider request is sent. */
export async function prepareOimPagination(
  context: PageContext,
  token: string | undefined,
  runtime: OimPaginationRuntime
): Promise<OimPaginationSession> {
  if (token === undefined) return { progress: newProgress(runtimeNow(runtime)) };
  const state = await decodePageToken(token, context, runtime);
  let resume: OimPaginationResume;
  if (state.style === "link") {
    const url = sameOriginUrl(state.cursor, context.baseUrl);
    if (url === undefined) throw new OimPaginationError("invalid_page_token");
    resume = { url };
  } else if (state.style === "body_cursor") {
    if (context.pagination.type !== "body_cursor") {
      throw new OimPaginationError("invalid_page_token");
    }
    resume = { bodyPointer: context.pagination.requestPointer, value: state.cursor };
  } else {
    if (context.pagination.type === "link" || context.pagination.type === "body_cursor") {
      throw new OimPaginationError("invalid_page_token");
    }
    resume = { parameter: context.pagination.requestParameter, value: state.cursor };
  }
  return {
    progress: {
      pages: state.progress.pages,
      items: state.progress.items,
      bytes: state.progress.bytes,
      startedAt: state.progress.startedAtMs,
    },
    previousCursor: state.cursor,
    resume,
  };
}

/** Mints the token for the page after this one, or undefined when the provider says it is last. */
export async function nextPageToken(
  context: PageContext,
  session: OimPaginationSession,
  body: unknown,
  headers: Readonly<Record<string, string>>,
  runtime: OimPaginationRuntime,
  currentUrl: string = context.baseUrl,
  resolveLink?: (candidate: string) => string | undefined
): Promise<string | undefined> {
  const { pagination, toolId, scope } = context;
  const canContinue = recordPage(
    session.progress,
    body,
    pagination.itemsPath,
    context.bounds ?? DEFAULT_OIM_PAGINATION_BOUNDS,
    runtimeNow(runtime)
  );
  const mint = async (cursor: string): Promise<string> => {
    let token: string;
    try {
      token = await runtime.codec.seal({
        version: STATE_VERSION,
        toolId,
        scope,
        style: pagination.type,
        cursor,
        progress: {
          pages: session.progress.pages,
          items: session.progress.items,
          bytes: session.progress.bytes,
          startedAtMs: session.progress.startedAt,
        },
      });
    } catch {
      throw new OimPaginationError("pagination_codec_failed");
    }
    if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
      throw new OimPaginationError("pagination_codec_failed");
    }
    return token;
  };

  if (pagination.type === "link") {
    const target = parseNextLink(headers[(pagination.header ?? "link").toLowerCase()]);
    const neutralTarget =
      target === undefined ? undefined : resolveLink === undefined ? target : resolveLink(target);
    const resolved =
      neutralTarget === undefined
        ? undefined
        : sameOriginUrl(neutralTarget, currentUrl, context.baseUrl);
    return resolved === undefined || !canContinue ? undefined : await mint(resolved);
  }
  if (pagination.type === "page") {
    const start = pagination.start ?? 1;
    const current = session.previousCursor === undefined ? start : Number(session.previousCursor);
    if (!Number.isFinite(current)) return undefined;
    // A page-number provider has no "last page" signal, so an empty page is the only honest stop.
    return isEmptyPage(body, pagination.itemsPath) || !canContinue
      ? undefined
      : await mint(String(current + 1));
  }
  const cursor = readPointer(body, pagination.responsePath);
  const next =
    typeof cursor === "string" && cursor.length > 0
      ? cursor
      : typeof cursor === "number" && Number.isFinite(cursor)
        ? String(cursor)
        : undefined;
  if (next === undefined || next.length > MAX_CURSOR_LENGTH || !canContinue) return undefined;
  // Some providers echo the cursor they were given on the last page instead of omitting it. Minting
  // it again would hand the caller a token that fetches the same page forever, and the page cap
  // would be the only thing that ever stopped it.
  if (session.previousCursor === next) return undefined;
  return await mint(next);
}

function isEmptyPage(body: unknown, itemsPath: string | undefined): boolean {
  const items = itemsPath === undefined ? body : readPointer(body, itemsPath);
  return Array.isArray(items) ? items.length === 0 : items === undefined;
}

function sameOriginUrl(
  candidate: string,
  resolutionBase: string,
  operationBase: string = resolutionBase
): string | undefined {
  try {
    const operationUrl = new URL(operationBase);
    const target = new URL(candidate, new URL(resolutionBase));
    return target.protocol === "https:" && target.origin === operationUrl.origin
      ? target.href
      : undefined;
  } catch {
    return undefined;
  }
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
