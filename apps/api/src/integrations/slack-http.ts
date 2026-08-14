import type {
  IntegrationHttpPort,
  IntegrationHttpRequest,
  IntegrationHttpResponse,
} from "@tulipfarm/integrations";

/** Local Slack Web API port copy; apps may not import each other. */

export const SLACK_API_BASE_URL = "https://slack.com/api";

export interface SlackWebApiHttpOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class SlackWebApiHttp implements IntegrationHttpPort {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: SlackWebApiHttpOptions = {}) {
    this.baseUrl = options.baseUrl ?? SLACK_API_BASE_URL;
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

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: request.method,
        headers: {
          authorization: `Bearer ${credential}`,
          accept: "application/json",
          ...(request.body === undefined ? {} : { "content-type": "application/json" }),
          ...request.headers,
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
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
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
