import type {
  GooglePortResolver,
  GoogleService,
  IntegrationHttpPort,
  IntegrationHttpRequest,
  IntegrationHttpResponse,
} from "@tulipfarm/integrations";

/** Local Google REST port copy; apps may not import each other. Bearer-authenticated JSON. */

export const GMAIL_API_BASE_URL = "https://gmail.googleapis.com/gmail/v1";

/** One base URL per Google service host, so a single login can reach all four APIs. */
export const GOOGLE_SERVICE_BASE_URLS: Record<GoogleService, string> = {
  gmail: GMAIL_API_BASE_URL,
  calendar: "https://www.googleapis.com/calendar/v3",
  drive: "https://www.googleapis.com/drive/v3",
  docs: "https://docs.googleapis.com/v1",
};

export interface GoogleApiHttpOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class GoogleApiHttp implements IntegrationHttpPort {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: GoogleApiHttpOptions = {}) {
    this.baseUrl = options.baseUrl ?? GMAIL_API_BASE_URL;
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

/** A resolver that lazily builds one bearer-authenticated port per Google service host. */
export function buildGooglePorts(fetchImpl?: typeof globalThis.fetch): GooglePortResolver {
  const ports = new Map<GoogleService, GoogleApiHttp>();
  return (service) => {
    const existing = ports.get(service);
    if (existing !== undefined) return existing;
    const port = new GoogleApiHttp({
      baseUrl: GOOGLE_SERVICE_BASE_URLS[service],
      ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    });
    ports.set(service, port);
    return port;
  };
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
