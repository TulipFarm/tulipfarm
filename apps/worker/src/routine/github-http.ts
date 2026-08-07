import type {
  IntegrationHttpPort,
  IntegrationHttpRequest,
  IntegrationHttpResponse,
} from "@tulipfarm/integrations";

/**
 * Concrete GitHub REST transport for this app's `IntegrationHttpPort`. A deliberate local copy of
 * `apps/integration-worker/src/github/http.ts` / `apps/api/src/integrations/github-http.ts` — an
 * application may not import another application (see `AGENTS.md`).
 */

export const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

export interface GitHubRestHttpOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class GitHubRestHttp implements IntegrationHttpPort {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: GitHubRestHttpOptions = {}) {
    this.baseUrl = options.baseUrl ?? GITHUB_API_BASE_URL;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async send(
    request: IntegrationHttpRequest,
    credential: string
  ): Promise<IntegrationHttpResponse> {
    const url = new URL(`${this.baseUrl}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      url.searchParams.set(key, value);
    }

    const response = await this.fetchImpl(url.toString(), {
      method: request.method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${credential}`,
        "x-github-api-version": GITHUB_API_VERSION,
        ...(request.body === undefined ? {} : { "content-type": "application/json" }),
        ...request.headers,
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    });

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: await parseBody(response),
    };
  }
}

/** GitHub answers some calls with an empty body; treat that as `undefined`, not a parse failure. */
async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
