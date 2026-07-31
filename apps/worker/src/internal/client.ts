/**
 * Transport for `/api/v1/internal/*` (plan §3).
 *
 * The Worker executes turns while the conversation history, the Soul artifacts, and the Tool
 * catalog still live in `apps/api`, and an application may not import another application. This is
 * the only place that knows the boundary is HTTP: everything above it speaks the ports in
 * `turn/driver.ts` and `@tulipfarm/agent-runtime`, so PR 4 replaces the implementations without
 * touching a caller.
 *
 * The credential is a service API-client secret. It is a key to *act on a Run*, never a principal:
 * the host derives authority from each Run's recorded subject, so this client states which Run and
 * never claims whom it is acting as.
 */

/** A response the host refused or could not serve. Carries the status so callers can branch. */
export class InternalApiError extends Error {
  readonly name = "InternalApiError";

  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly detail: string
  ) {
    super(`${method} ${path} failed with ${status}: ${detail}`);
  }
}

export interface InternalApiClientOptions {
  /** Base URL of the API, without a trailing slash — e.g. `http://api:4010`. */
  readonly baseUrl: string;
  /** `tfc_<clientId>.<secret>`, minted as an API client with a service principal. */
  readonly credential: string;
  readonly timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class InternalApiClient {
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: InternalApiClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * One call whose answer must exist. Anything other than a body is a fault, including `204` — a
   * caller that asked for a Context or dispatched a Tool has nothing to fall back on.
   */
  async require<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const response = await this.send(method, path, body);
    if (!response.ok || response.status === 204) {
      throw new InternalApiError(response.status, method, path, await safeText(response));
    }
    return (await response.json()) as T;
  }

  /**
   * One call whose answer may legitimately be "nothing".
   *
   * `absentOn` names exactly which statuses mean that, and every other failure still throws. It is
   * a parameter rather than a blanket rule because the difference matters: `204` on a completion
   * lookup means this attempt has not finished yet, while `404` on the same path means the Run is
   * gone — reading the second as the first would let a redelivered job answer twice.
   */
  async find<T>(
    method: "GET" | "POST",
    path: string,
    absentOn: readonly number[],
    body?: unknown
  ): Promise<T | undefined> {
    const response = await this.send(method, path, body);
    if (absentOn.includes(response.status)) return undefined;
    if (!response.ok) {
      throw new InternalApiError(response.status, method, path, await safeText(response));
    }
    return (await response.json()) as T;
  }

  private async send(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
    return this.fetch(`${this.options.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.options.credential}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }
}

/** A failure reading the error body must not replace the status that explains the failure. */
async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return response.statusText;
  }
}
