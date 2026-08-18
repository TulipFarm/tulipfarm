/** HTTP boundary to the API; the credential acts on Runs and never names a principal. */

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

  /** Require a body; `204` is a fault when the caller has no fallback. */
  async require<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const response = await this.send(method, path, body);
    if (!response.ok || response.status === 204) {
      throw new InternalApiError(response.status, method, path, await safeText(response));
    }
    return (await response.json()) as T;
  }

  /** Only `absentOn` statuses mean missing; other failures still throw to prevent replay lies. */
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

  /**
   * Fetch raw bytes rather than JSON. `undefined` for the `absentOn` statuses.
   *
   * Separate from `find` because a File's bytes are not JSON and buffering them through
   * `response.json()` would both fail and lie about why.
   */
  async bytes(path: string, absentOn: readonly number[]): Promise<Uint8Array | undefined> {
    const response = await this.send("GET", path);
    if (absentOn.includes(response.status)) return undefined;
    if (!response.ok) {
      throw new InternalApiError(response.status, "GET", path, await safeText(response));
    }
    return new Uint8Array(await response.arrayBuffer());
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
