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

export function normalizedPublicUrl(rawUrl: string): URL {
  if (rawUrl.length > 2_000) throw new Error("URL exceeds 2000 characters");
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("URL is invalid");
  }
  assertPublicEgressUrl(url, rawUrl);
  return url;
}

/** Follow only same-origin redirects; every new URL still traverses the destination cage. */
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
    });
    const location = response.headers.location ?? response.headers.Location;
    if (!NETWORK_REDIRECT_STATUSES.has(response.status) || location === undefined) {
      return { kind: "response", url: current.href, response };
    }
    if (redirects >= maxRedirects) return { kind: "redirect_limit", url: current.href };
    const next = normalizedPublicUrl(new URL(location, current).href);
    if (next.origin !== current.origin) {
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

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

/** Bounded, dependency-free readable text for model extraction; scripts and styles never survive. */
export function readableWebContent(contentType: string | undefined, body: unknown): string {
  // `JSON.stringify(undefined)` is `undefined`, not a string: an empty or failed response would
  // otherwise return a non-string from a `string` signature and crash every caller that slices it.
  const raw = typeof body === "string" ? body : (JSON.stringify(body, null, 2) ?? "");
  if (!contentType?.toLowerCase().includes("text/html")) return raw;
  return raw
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|section|article|header|footer|main|aside|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (_entity, code: string) => {
      if (code.startsWith("#x")) return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
      if (code.startsWith("#")) return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
      return HTML_ENTITIES[code.toLowerCase()] ?? " ";
    })
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}
