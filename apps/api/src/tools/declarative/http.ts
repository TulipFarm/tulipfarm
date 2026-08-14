import type {
  EgressHttpPort,
  EgressHttpRequest,
  IntegrationHttpResponse,
} from "@tulipfarm/integrations";

/** Manifest OpenAPI transport; applies no auth and maps network faults to 503. */

/** Third-party endpoints may stall; never let a socket pin a Run. */
const REQUEST_TIMEOUT_MS = 30_000;

export interface EgressHttpOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export class FetchEgressHttp implements EgressHttpPort {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: EgressHttpOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async send(request: EgressHttpRequest): Promise<IntegrationHttpResponse> {
    let response: Response;
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
      });
    } catch {
      return { status: 503, headers: {}, body: undefined };
    }

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: await parseBody(response),
    };
  }
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
