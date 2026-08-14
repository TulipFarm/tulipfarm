import type {
  IntegrationHttpPort,
  IntegrationHttpRequest,
  IntegrationHttpResponse,
} from "@tulipfarm/integrations";

/**
 * Jira Cloud transport: gateway-scoped to the installation `cloudId`; non-2xx returns and the
 * credential is retained for one request only.
 */

export const JIRA_API_BASE_URL = "https://api.atlassian.com/ex/jira";

export interface JiraRestHttpOptions {
  readonly cloudId: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class JiraRestHttp implements IntegrationHttpPort {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: JiraRestHttpOptions) {
    this.baseUrl = options.baseUrl ?? JIRA_API_BASE_URL;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async send(
    request: IntegrationHttpRequest,
    credential: string
  ): Promise<IntegrationHttpResponse> {
    const url = new URL(`${this.baseUrl}/${this.options.cloudId}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      url.searchParams.set(key, value);
    }

    const response = await this.fetchImpl(url.toString(), {
      method: request.method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${credential}`,
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

/** Jira transitions/deletes can return an empty body; that is a result, not a parse failure. */
async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
