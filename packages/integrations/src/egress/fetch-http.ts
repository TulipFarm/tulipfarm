import { Agent } from "undici";
import type { IntegrationHttpResponse } from "../http";
import type { EgressHttpPort, EgressHttpRequest } from "./openapi-adapter";

/** Manifest OpenAPI transport; applies no auth and maps network faults to 503. */

/**
 * Third-party endpoints may stall; never let a socket pin a Run.
 *
 * This bounds one hop. It is not what stops a request outliving the Tool that issued it — a
 * redirect chain restarts this timer at every hop, so the bound on the call as a whole is the
 * caller's own signal, which `deadline` honours alongside this one. A caller that passes no
 * signal gets this and nothing else, which is why it stays modest.
 */
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/**
 * How this deployment names itself to the sites it reads.
 *
 * An unidentified client is one a site operator can neither rate-limit nor exempt, so many refuse
 * it outright. Naming the product and linking somewhere explanatory is the convention that keeps
 * an automated reader welcome, and it is what a robots.txt rule matches on.
 */
const DEFAULT_USER_AGENT = "TulipFarm (+https://github.com/maddhruv/tulipfarm)";

export interface EgressHttpOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly userAgent?: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export class FetchEgressHttp implements EgressHttpPort {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly userAgent: string;

  constructor(options: EgressHttpOptions = {}) {
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  }

  async send(request: EgressHttpRequest): Promise<IntegrationHttpResponse> {
    let response: Response;
    const pinned = request.pinnedAddresses?.[0];
    const dispatcher =
      pinned === undefined
        ? undefined
        : new Agent({
            connect: {
              // undici's connector requests `{ all: true }` and expects an address array back in
              // that case; handing back a bare string makes it throw `Invalid IP address:
              // undefined`, which this class then reports as a spurious `network_unreachable`.
              lookup: (_hostname, options, callback) => {
                const family = pinned.includes(":") ? 6 : 4;
                if (options.all) {
                  callback(null, [{ address: pinned, family }]);
                } else {
                  callback(null, pinned, family);
                }
              },
            },
          });
    try {
      response = await this.fetchImpl(request.url, {
        method: request.method,
        headers: {
          accept: "application/json",
          "user-agent": this.userAgent,
          ...(request.body === undefined ? {} : { "content-type": "application/json" }),
          ...request.headers,
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        // Never follow redirects: a 3xx could walk an authenticated request, credential header
        // intact, to a host the manifest never declared.
        redirect: "manual",
        signal: deadline(this.timeoutMs, request.signal),
        ...(dispatcher === undefined ? {} : { dispatcher }),
      } as RequestInit);
    } catch (error) {
      await dispatcher?.close();
      // A network fault must not masquerade as an empty successful response. Readers downstream
      // treat a 503 with no body as content, and a caller can only choose between retrying and
      // reporting if the cause survives the transport boundary.
      return {
        status: 503,
        headers: { "content-type": "application/json" },
        body: networkFault(error, this.timeoutMs),
      };
    }

    try {
      const body = await parseBody(response, this.maxResponseBytes, request.acceptBinary === true);
      if (body === RESPONSE_TOO_LARGE) {
        return { status: 413, headers: {}, body: { error: "response_too_large" } };
      }
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body,
      };
    } finally {
      await dispatcher?.close();
    }
  }
}

/**
 * The transport's own deadline, or the caller's too when it brought one.
 *
 * Both must fire: the transport bounds a stalled socket, and the caller bounds the work it is
 * still waiting for. A redirect chain makes this load-bearing — each hop restarts the transport
 * timer, so only the caller's signal bounds the walk as a whole.
 */
function deadline(timeoutMs: number, caller: AbortSignal | undefined): AbortSignal {
  const own = AbortSignal.timeout(timeoutMs);
  return caller === undefined ? own : AbortSignal.any([own, caller]);
}

const RESPONSE_TOO_LARGE = Symbol("response_too_large");

/** Names a transport fault in terms a caller can act on; provider internals never travel with it. */
/**
 * Transport faults after which the destination may already have done the work.
 *
 * A timeout or an abort proves only that no answer came back — the request itself may well have
 * arrived and been acted on. A caller doing something mutating must settle such a call as
 * ambiguous rather than as a plain failure, or a retry duplicates the write.
 */
const INDETERMINATE_FAULTS: ReadonlySet<string> = new Set(["network_timeout", "network_aborted"]);

/** True when this synthetic response stands for a request that may have landed anyway. */
export function mayHaveReachedDestination(status: number, body: unknown): boolean {
  if (status !== 503 || typeof body !== "object" || body === null) return false;
  return INDETERMINATE_FAULTS.has(String((body as { error?: unknown }).error));
}

function networkFault(
  error: unknown,
  timeoutMs: number
): { readonly error: string; readonly message: string } {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError") {
    return {
      error: "network_timeout",
      message: `the destination did not answer in ${timeoutMs}ms`,
    };
  }
  if (name === "AbortError") {
    return { error: "network_aborted", message: "the request was cancelled before it answered" };
  }
  return { error: "network_unreachable", message: "the destination could not be reached" };
}

/**
 * Content types whose bytes are meant to be read as characters.
 *
 * The list is deliberately positive: anything unrecognised is treated as binary, so a new media
 * type is passed through intact rather than silently mangled by a UTF-8 decode.
 */
function isTextual(contentType: string | null): boolean {
  if (contentType === null) return true;
  const type = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (type === "") return true;
  if (type.startsWith("text/")) return true;
  if (type.endsWith("+json") || type.endsWith("+xml")) return true;
  return [
    "application/json",
    "application/xml",
    "application/javascript",
    "application/ecmascript",
    "application/x-ndjson",
    "application/x-www-form-urlencoded",
    "application/graphql",
  ].includes(type);
}

async function parseBody(
  response: Response,
  maxBytes: number,
  acceptBinary: boolean
): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    return RESPONSE_TOO_LARGE;
  }
  if (response.body === null) return undefined;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      return RESPONSE_TOO_LARGE;
    }
    chunks.push(chunk.value);
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (acceptBinary && !isTextual(response.headers.get("content-type"))) return joined;

  const text = new TextDecoder().decode(joined);
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
