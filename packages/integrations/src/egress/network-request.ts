import type { IntegrationHttpMethod, IntegrationHttpResponse } from "../http";
import { assertPublicEgressUrl } from "./destination";
import type { EgressHttpPort } from "./openapi-adapter";

export const NETWORK_READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export const NETWORK_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type GraphqlOperationKind = "query" | "mutation" | "subscription";

export interface GovernedHttpRequest {
  readonly url: string;
  readonly method: IntegrationHttpMethod;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /**
   * Whether these headers carry a leased Secret.
   *
   * Declared by the caller, never guessed from a header name: a Credential may name any header
   * the destination asks for, so `X-Service-Key` is as real a Secret as `authorization`. Guessing
   * would silently widen the redirect rule for exactly the requests it must not widen for.
   */
  readonly carriesCredential?: boolean;
  /**
   * Re-checks every hop against whatever narrowed this request beyond the deployment's own cage —
   * a Skill's declared destinations, for instance. Throws to refuse.
   *
   * Checking only the URL the caller passed would let a page under a declared origin redirect to
   * its `www.` variant, which is a host that Skill never declared and which can be taken over
   * independently of the apex.
   */
  readonly assertDestination?: (origin: string) => void;
  /** Hand back undecoded bytes for a non-text response, for a caller that can extract them. */
  readonly acceptBinary?: boolean;
  /** The caller's deadline, so abandoning the call also abandons the redirect walk under way. */
  readonly signal?: AbortSignal;
}

export type GovernedHttpResult =
  | { readonly kind: "response"; readonly url: string; readonly response: IntegrationHttpResponse }
  | {
      readonly kind: "cross_origin_redirect";
      readonly from: string;
      readonly to: string;
      readonly status: number;
    }
  | { readonly kind: "redirect_limit"; readonly url: string };

function skipString(document: string, start: number): number {
  const block = document.startsWith('"""', start);
  const delimiter = block ? '"""' : '"';
  let index = start + delimiter.length;
  while (index < document.length) {
    if (document.startsWith(delimiter, index)) return index + delimiter.length;
    if (!block && document[index] === "\\") index += 1;
    index += 1;
  }
  throw new Error("unterminated GraphQL string");
}

function graphqlTokens(document: string): string[] {
  const tokens: string[] = [];
  for (let index = 0; index < document.length; ) {
    const char = document[index];
    if (char === "#") {
      while (index < document.length && document[index] !== "\n") index += 1;
      continue;
    }
    if (char === '"') {
      index = skipString(document, index);
      tokens.push("string");
      continue;
    }
    if (char !== undefined && /[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (end < document.length && /[A-Za-z0-9_]/.test(document[end] ?? "")) end += 1;
      tokens.push(document.slice(index, end));
      index = end;
      continue;
    }
    if (char !== undefined && "{}()!$:@[]=|".includes(char)) tokens.push(char);
    index += 1;
  }
  return tokens;
}

/** Select and classify one GraphQL operation without executing directives or trusting a regex. */
export function classifyGraphqlOperation(
  document: string,
  operationName?: string
): GraphqlOperationKind {
  const tokens = graphqlTokens(document);
  const operations: { readonly kind: GraphqlOperationKind; readonly name?: string }[] = [];
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "{") {
      if (depth === 0 && operations.length === 0) operations.push({ kind: "query" });
      depth += 1;
      continue;
    }
    if (token === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0 || (token !== "query" && token !== "mutation" && token !== "subscription")) {
      continue;
    }
    const next = tokens[index + 1];
    operations.push({
      kind: token,
      ...(next !== undefined && /^[A-Za-z_]/.test(next) ? { name: next } : {}),
    });
  }
  if (operations.length === 0) throw new Error("GraphQL document contains no operation");
  if (operationName !== undefined) {
    const selected = operations.find((operation) => operation.name === operationName);
    if (selected === undefined)
      throw new Error(`GraphQL operation "${operationName}" was not found`);
    return selected.kind;
  }
  if (operations.length !== 1)
    throw new Error("operationName is required for multiple GraphQL operations");
  return operations[0]?.kind ?? "query";
}

/**
 * The one place a caller-supplied URL becomes the URL this deployment will actually use.
 *
 * `http:` is rewritten to `https:` here rather than at a Tool, so that authorization, the Skill
 * destination check, the audit target and the request itself all reason about the same origin. A
 * Tool that upgraded privately would be authorized against `http://host` and then fetch
 * `https://host`, which is the shape of an authorization bypass even when both resolve alike.
 *
 * Only this scheme is rewritten, and only here: a manifest's declared `base_url` goes through
 * `assertPublicEgressUrl` directly, so writing `http://` into config still fails loudly instead of
 * being silently corrected. Upgrading a redirect target has the same justification as upgrading
 * the first hop — a destination answering `301 http://…` is asking to have TLS stripped.
 */
export function normalizedPublicUrl(rawUrl: string): URL {
  if (rawUrl.length > 2_000) throw new Error("URL exceeds 2000 characters");
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("URL is invalid");
  }
  if (url.protocol === "http:") url.protocol = "https:";
  assertPublicEgressUrl(url, rawUrl);
  return url;
}

/**
 * Whether a redirect only adds or drops the `www.` label of the same site.
 *
 * `https://example.com` answering `301 https://www.example.com` is the single most common
 * redirect on the web, and refusing it made `web_fetch` unable to read a large share of the
 * internet. Scheme and port must still match exactly, so this never downgrades or re-ports.
 */
function isWwwVariant(current: URL, next: URL): boolean {
  if (current.protocol !== next.protocol || current.port !== next.port) return false;
  const strip = (host: string) => (host.startsWith("www.") ? host.slice(4) : host);
  return current.hostname !== next.hostname && strip(current.hostname) === strip(next.hostname);
}

/**
 * A backstop for a caller that attached something authenticating and did not say so.
 *
 * `carriesCredential` is the authoritative answer, because a Credential may name any header. This
 * only catches the obvious spellings, so forgetting the flag fails closed for the common case
 * instead of silently widening the redirect rule.
 */
function hasAuthHeader(headers: Readonly<Record<string, string>> | undefined): boolean {
  return Object.keys(headers ?? {}).some((name) =>
    /(^|[-_])(authorization|authentication|cookie|api[-_]?key|token|secret|credential)([-_]|$)/i.test(
      name
    )
  );
}

/** Follow only same-site redirects; every new URL still traverses the destination cage. */
export async function sendGovernedRequest(
  http: EgressHttpPort,
  input: GovernedHttpRequest,
  maxRedirects = 10
): Promise<GovernedHttpResult> {
  let current = normalizedPublicUrl(input.url);
  for (let redirects = 0; ; redirects += 1) {
    const response = await http.send({
      url: current.href,
      method: input.method,
      headers: input.headers ?? {},
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.acceptBinary === true ? { acceptBinary: true } : {}),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const location = response.headers.location ?? response.headers.Location;
    if (!NETWORK_REDIRECT_STATUSES.has(response.status) || location === undefined) {
      return { kind: "response", url: current.href, response };
    }
    if (redirects >= maxRedirects) return { kind: "redirect_limit", url: current.href };
    const next = normalizedPublicUrl(new URL(location, current).href);
    // A `www.` host is a different host, and a subdomain can be taken over independently of its
    // apex. Following the redirect is safe for an anonymous read and not safe while holding
    // someone else's Secret, so the widening applies only to an unauthenticated request.
    const authenticated = input.carriesCredential === true || hasAuthHeader(input.headers);
    const sameSite =
      next.origin === current.origin || (isWwwVariant(current, next) && !authenticated);
    if (sameSite && next.origin !== current.origin) input.assertDestination?.(next.origin);
    if (!sameSite) {
      return {
        kind: "cross_origin_redirect",
        from: current.origin,
        to: next.href,
        status: response.status,
      };
    }
    current = next;
  }
}
