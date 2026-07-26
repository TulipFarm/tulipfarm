/**
 * Provider-neutral HTTP boundary shared by the maintained Integration adapters (SPEC §15).
 *
 * Adapters describe *what* they want from a provider; the concrete transport (fetch, retries at
 * the socket level, TLS, base URL, auth header shape) lives in the composing application. That
 * keeps provider SDKs out of the control plane and lets every adapter be exercised deterministically
 * without a network.
 *
 * The classification below is the single place where an HTTP status becomes a durability decision.
 * The distinction that matters is `before_dispatch` versus `after_dispatch`: the Tool Broker turns
 * an `after_dispatch` failure on a mutating contract into an *ambiguous* effect that must be
 * reconciled, never into a silent retry. A status we cannot prove was rejected before the provider
 * acted is therefore classified as `after_dispatch` for mutations.
 */

export type IntegrationHttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface IntegrationHttpRequest {
  readonly method: IntegrationHttpMethod;
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface IntegrationHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/** Sends one request with an already-leased credential. The credential is never retained. */
export interface IntegrationHttpPort {
  send(request: IntegrationHttpRequest, credential: string): Promise<IntegrationHttpResponse>;
}

export type IntegrationHttpFailureCode =
  | "provider_unauthorized"
  | "provider_not_found"
  | "provider_conflict"
  | "provider_rejected"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "provider_error";

export interface HttpFailureClassification {
  readonly phase: "before_dispatch" | "after_dispatch";
  readonly code: IntegrationHttpFailureCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

function retryAfterMs(headers: Readonly<Record<string, string>>): number | undefined {
  const value = headers["retry-after"] ?? headers["Retry-After"];
  if (value === undefined) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/**
 * Map one provider response onto a durability classification, or `null` when it succeeded.
 * `mutating` is the contract's own declaration, not a guess from the HTTP verb.
 */
export function classifyHttpFailure(
  response: IntegrationHttpResponse,
  mutating: boolean
): HttpFailureClassification | null {
  const { status } = response;
  if (status >= 200 && status < 300) return null;

  if (status === 401 || status === 403) {
    return { phase: "before_dispatch", code: "provider_unauthorized", retryable: false };
  }
  if (status === 404 || status === 410) {
    return { phase: "before_dispatch", code: "provider_not_found", retryable: false };
  }
  if (status === 409) {
    return { phase: "before_dispatch", code: "provider_conflict", retryable: false };
  }
  if (status === 422) {
    return { phase: "before_dispatch", code: "provider_rejected", retryable: false };
  }
  if (status === 429) {
    const delay = retryAfterMs(response.headers);
    return {
      phase: "before_dispatch",
      code: "provider_rate_limited",
      retryable: true,
      ...(delay === undefined ? {} : { retryAfterMs: delay }),
    };
  }
  if (status >= 500) {
    // A mutation that got a 5xx may or may not have been applied. Say so rather than retrying.
    return {
      phase: mutating ? "after_dispatch" : "before_dispatch",
      code: "provider_unavailable",
      retryable: true,
    };
  }
  return { phase: "before_dispatch", code: "provider_error", retryable: false };
}

export type PaginationBound = "max_pages" | "max_items";

/** Raised instead of silently truncating a paged read past its declared bound. */
export class PaginationBoundError extends Error {
  readonly name = "PaginationBoundError";

  constructor(readonly bound: PaginationBound) {
    super(`pagination_bound_exceeded:${bound}`);
  }
}

export interface PaginationBounds {
  readonly maxPages: number;
  readonly maxItems: number;
}

export interface PageResult<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

/**
 * Walk a cursor-paged provider read under explicit bounds. Exceeding either bound is an error, not
 * a truncation: a caller reasoning over "every matching issue" must never be handed a silent
 * prefix of the answer.
 */
export async function collectPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<PageResult<T>>,
  bounds: PaginationBounds
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < bounds.maxPages; page += 1) {
    const result = await fetchPage(cursor);
    if (items.length + result.items.length > bounds.maxItems) {
      throw new PaginationBoundError("max_items");
    }
    items.push(...result.items);
    if (result.nextCursor === undefined) return items;
    cursor = result.nextCursor;
  }
  throw new PaginationBoundError("max_pages");
}
