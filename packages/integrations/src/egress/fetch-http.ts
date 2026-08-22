import { Agent } from "undici";
import type { IntegrationHttpResponse } from "../http";
import type { EgressHttpPort, EgressHttpRequest } from "./openapi-adapter";

/** Manifest OpenAPI transport; applies no auth and maps network faults to 503. */

/** Third-party endpoints may stall; never let a socket pin a Run. */
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export interface EgressHttpOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export class FetchEgressHttp implements EgressHttpPort {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: EgressHttpOptions = {}) {
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
              lookup: (_hostname, _options, callback) => {
                callback(null, pinned, pinned.includes(":") ? 6 : 4);
              },
            },
          });
    try {
      response = await this.fetchImpl(request.url, {
        method: request.method,
        headers: {
          accept: "application/json",
          ...(request.body === undefined ? {} : { "content-type": "application/json" }),
          ...request.headers,
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        // Never follow redirects: a 3xx could walk an authenticated request, credential header
        // intact, to a host the manifest never declared.
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(dispatcher === undefined ? {} : { dispatcher }),
      } as RequestInit);
    } catch {
      await dispatcher?.close();
      return { status: 503, headers: {}, body: undefined };
    }

    try {
      const body = await parseBody(response, this.maxResponseBytes);
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

const RESPONSE_TOO_LARGE = Symbol("response_too_large");

async function parseBody(response: Response, maxBytes: number): Promise<unknown> {
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
  const text = new TextDecoder().decode(joined);
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
