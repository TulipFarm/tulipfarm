import type {
  IntegrationHttpPort,
  IntegrationHttpRequest,
  IntegrationHttpResponse,
} from "@tulipfarm/integrations";

export interface TelegramBotApiHttpOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

/** Stateless Telegram Bot API transport. The leased Credential is never retained. */
export class TelegramBotApiHttp implements IntegrationHttpPort {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: TelegramBotApiHttpOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://api.telegram.org";
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async send(
    request: IntegrationHttpRequest,
    credential: string
  ): Promise<IntegrationHttpResponse> {
    const url = new URL(`${this.baseUrl}/bot${credential}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      url.searchParams.set(key, value);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: request.method,
        headers: {
          accept: "application/json",
          ...(request.body === undefined ? {} : { "content-type": "application/json" }),
          ...request.headers,
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
    } catch {
      return { status: 503, headers: {}, body: undefined };
    }
    const text = await response.text();
    let body: unknown;
    try {
      body = text.length === 0 ? undefined : JSON.parse(text);
    } catch {
      body = text;
    }
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    };
  }
}
