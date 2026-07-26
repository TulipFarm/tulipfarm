import { isIP } from "node:net";

export type OutboundHttpErrorCode =
  | "destination_denied"
  | "dlp_denied"
  | "invalid_destination"
  | "ledger_conflict"
  | "private_destination"
  | "redirect_denied"
  | "response_schema_mismatch"
  | "timeout"
  | "transport_failure"
  | "unexpected_status"
  | "unresolved_destination";

export type OutboundHttpFailurePhase = "before_dispatch" | "after_dispatch";

export class OutboundHttpError extends Error {
  readonly name = "OutboundHttpError";

  constructor(
    readonly code: OutboundHttpErrorCode,
    readonly phase: OutboundHttpFailurePhase
  ) {
    super(`outbound_http:${phase}:${code}`);
  }
}

export interface OutboundHttpConfig {
  readonly allowedDestinations: readonly string[];
  readonly maximumRedirects: number;
  readonly timeoutMs: number;
}

export interface OutboundHttpRequest {
  readonly integrationId: string;
  readonly destination: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly idempotencyKey: string;
  readonly responseSchema: unknown;
}

export interface OutboundHttpResult {
  readonly status: number;
  readonly body: unknown;
}

export interface OutboundHttpTransportRequest {
  readonly method: OutboundHttpRequest["method"];
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /** Concrete transports must not follow redirects automatically. */
  readonly redirect: "manual";
}

export interface OutboundHttpTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface OutboundHttpTransport {
  send(
    request: OutboundHttpTransportRequest,
    options: { readonly approvedAddresses: readonly string[]; readonly timeoutMs: number }
  ): Promise<OutboundHttpTransportResponse>;
}

export interface OutboundHttpDependencies {
  readonly transport: OutboundHttpTransport;
  readonly resolve: (hostname: string) => Promise<readonly string[]>;
  readonly inspectDlp: (input: {
    readonly integrationId: string;
    readonly destination: string;
    readonly body: unknown;
  }) => Promise<boolean>;
  readonly validateResponse: (schema: unknown, value: unknown) => boolean;
  readonly ledger: {
    begin(
      idempotencyKey: string
    ): Promise<
      | { readonly outcome: "started" }
      | { readonly outcome: "duplicate"; readonly result?: OutboundHttpResult }
    >;
    complete(idempotencyKey: string, result: OutboundHttpResult): Promise<OutboundHttpResult>;
    ambiguous(idempotencyKey: string, reason: string): Promise<void>;
  };
}

/** Render a JSON-shaped delivery template. It supports substitutions only, never expressions. */
export function renderOutboundHttpTemplate(
  template: unknown,
  values: Readonly<Record<string, unknown>>
): unknown {
  if (typeof template === "string") {
    return template.replace(/\{\{([A-Za-z0-9_-]+)\}\}/g, (_match, name: string) => {
      const value = values[name];
      if (value === undefined || value === null) return "";
      return typeof value === "string" ? value : JSON.stringify(value);
    });
  }
  if (Array.isArray(template)) {
    return template.map((value) => renderOutboundHttpTemplate(value, values));
  }
  if (typeof template === "object" && template !== null) {
    return Object.fromEntries(
      Object.entries(template).map(([key, value]) => [
        key,
        renderOutboundHttpTemplate(value, values),
      ])
    );
  }
  return template;
}

function normalizedOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OutboundHttpError("invalid_destination", "before_dispatch");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname === ""
  ) {
    throw new OutboundHttpError("invalid_destination", "before_dispatch");
  }
  return url.origin;
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return true;
  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  const mappedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mappedIpv4 !== undefined && isPrivateIpv4(mappedIpv4);
}

export function isPrivateNetworkAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

function normalizedHeaders(
  headers: Readonly<Record<string, string>>,
  idempotencyKey: string
): Record<string, string> {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  );
  normalized["idempotency-key"] = idempotencyKey;
  return normalized;
}

function redirectLocation(response: OutboundHttpTransportResponse, current: URL): URL | undefined {
  if (![301, 302, 303, 307, 308].includes(response.status)) return undefined;
  const location = response.headers.location ?? response.headers.Location;
  if (location === undefined) {
    throw new OutboundHttpError("redirect_denied", "after_dispatch");
  }
  try {
    return new URL(location, current);
  } catch {
    throw new OutboundHttpError("redirect_denied", "after_dispatch");
  }
}

export class OutboundHttpAdapter {
  private readonly allowedOrigins: ReadonlySet<string>;

  constructor(
    private readonly config: OutboundHttpConfig,
    private readonly dependencies: OutboundHttpDependencies
  ) {
    this.allowedOrigins = new Set(config.allowedDestinations.map(normalizedOrigin));
  }

  async deliver(request: OutboundHttpRequest): Promise<OutboundHttpResult> {
    let destination = this.allowedUrl(request.destination);
    const dlpAllowed = await this.dependencies.inspectDlp({
      integrationId: request.integrationId,
      destination: destination.toString(),
      body: request.body,
    });
    if (!dlpAllowed) throw new OutboundHttpError("dlp_denied", "before_dispatch");

    const begun = await this.dependencies.ledger.begin(request.idempotencyKey);
    if (begun.outcome === "duplicate") {
      if (begun.result === undefined) {
        throw new OutboundHttpError("ledger_conflict", "before_dispatch");
      }
      return begun.result;
    }

    try {
      for (let redirectCount = 0; ; redirectCount += 1) {
        if (redirectCount > this.config.maximumRedirects) {
          throw new OutboundHttpError("redirect_denied", "after_dispatch");
        }
        const addresses = await this.publicAddresses(destination.hostname);
        if (redirectCount > 0) {
          const redirectDlpAllowed = await this.dependencies.inspectDlp({
            integrationId: request.integrationId,
            destination: destination.toString(),
            body: request.body,
          });
          if (!redirectDlpAllowed) {
            throw new OutboundHttpError("dlp_denied", "after_dispatch");
          }
        }
        const response = await this.dependencies.transport.send(
          {
            method: request.method,
            url: destination.toString(),
            headers: normalizedHeaders(request.headers, request.idempotencyKey),
            ...(request.body === undefined ? {} : { body: request.body }),
            redirect: "manual",
          },
          { approvedAddresses: addresses, timeoutMs: this.config.timeoutMs }
        );
        const redirected = redirectLocation(response, destination);
        if (redirected !== undefined) {
          destination = this.allowedUrl(redirected.toString());
          continue;
        }
        if (response.status < 200 || response.status >= 300) {
          throw new OutboundHttpError("unexpected_status", "after_dispatch");
        }
        if (!this.dependencies.validateResponse(request.responseSchema, response.body)) {
          throw new OutboundHttpError("response_schema_mismatch", "after_dispatch");
        }
        return await this.dependencies.ledger.complete(request.idempotencyKey, {
          status: response.status,
          body: response.body,
        });
      }
    } catch (error) {
      const failure =
        error instanceof OutboundHttpError
          ? error
          : new OutboundHttpError("transport_failure", "after_dispatch");
      if (failure.phase === "after_dispatch") {
        await this.dependencies.ledger.ambiguous(request.idempotencyKey, failure.code);
      }
      throw failure;
    }
  }

  private allowedUrl(value: string): URL {
    const origin = normalizedOrigin(value);
    if (!this.allowedOrigins.has(origin)) {
      throw new OutboundHttpError("destination_denied", "before_dispatch");
    }
    return new URL(value);
  }

  private async publicAddresses(hostname: string): Promise<readonly string[]> {
    const addresses = await this.dependencies.resolve(hostname);
    if (addresses.length === 0) {
      throw new OutboundHttpError("unresolved_destination", "before_dispatch");
    }
    if (addresses.some(isPrivateNetworkAddress)) {
      throw new OutboundHttpError("private_destination", "before_dispatch");
    }
    return addresses;
  }
}
