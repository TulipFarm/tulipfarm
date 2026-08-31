import { extractText } from "@tulipfarm/files";
import type { IntegrationHttpMethod, IntegrationHttpResponse } from "@tulipfarm/integrations";
import {
  classifyGraphqlOperation,
  type EgressHttpPort,
  egressDenialReason,
  type GovernedHttpResult,
  mayHaveReachedDestination,
  NETWORK_READ_METHODS,
  normalizedPublicUrl,
  type RenderedWebContent,
  renderWebContent,
  sendGovernedRequest,
} from "@tulipfarm/integrations";
import { API_REQUEST_TOOL_DECLARATION, WEB_FETCH_TOOL_DECLARATION } from "@tulipfarm/schema";
import { SecretUnavailableError } from "@tulipfarm/secrets";
import type { CachePort } from "@tulipfarm/storage";
import { defineApiTool, err, ok } from "@tulipfarm/tool-host";

const MAX_MODEL_CONTENT_CHARS = 100_000;
/**
 * How long a fetched page is reused.
 *
 * Long enough that an Agent re-reading the same documentation across several Turns of one task
 * does not fetch it each time; short enough that a page it is actively watching for a change is
 * not stale for a whole session. Only successful reads are held — a refusal or a 500 is usually
 * the moment rather than the page, and caching one would keep answering with it.
 */
const WEB_FETCH_CACHE_TTL_MS = 15 * 60 * 1_000;
/**
 * How long a network Tool call may take, overriding the shorter default every Tool otherwise gets.
 *
 * A documentation site behind a cold cache, or one that renders before it answers, routinely
 * spends longer than the half minute that suits a Tool talking to this deployment's own database.
 * It sits above the per-hop socket deadline so a single slow hop reports a timeout as itself
 * rather than as the whole Tool being abandoned, and the margin covers reading the body and
 * rendering or extracting it after the last byte lands.
 */
const NETWORK_TOOL_TIMEOUT_MS = 75_000;
/** Enough of a failing server's own words for the model to choose a next step, not a second page. */
const MAX_FAILURE_DETAIL_CHARS = 500;
/** Headers the transport owns; setting one corrupts the request or the connection. */
const TRANSPORT_HEADERS = new Set([
  "connection",
  "content-length",
  "cookie",
  "host",
  "proxy-authorization",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Headers that carry a credential, and are therefore refused in the free-form `headers` map.
 *
 * Only the `credential` field reaches the Secret broker, and only a call carrying it is classified
 * as needing an exact Approval. A literal token pasted into `headers` would spend the deployment's
 * authority with no lease, no `secret.use` grant check, and — on a read — no Approval at all, so
 * the free-form map is the wrong door for one regardless of where the token came from.
 */
const CREDENTIAL_HEADERS = new Set([
  "authentication",
  "authorization",
  "proxy-authorization",
  "x-amz-security-token",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
  "x-goog-api-key",
]);

/**
 * The words that make a header name a credential, whatever separator a vendor chose.
 *
 * Deliberately excludes the bare word "api": it names a namespace or a version
 * (`X-GitHub-Api-Version`, `X-Api-Version`), not a secret, and every vendor header that actually
 * carries one pairs "api" with a word already in this list (`x-api-key`, `x-goog-api-key`), so
 * dropping "api" alone loses no real credential while it stops flagging version/negotiation
 * headers.
 */
const CREDENTIAL_WORDS =
  /(^|-)(access|auth|authentication|authorization|bearer|credential|jwt|key|passwd|password|secret|session|signature|token)(-|$)/;

/**
 * Any header whose name reads as a key, token, secret or password, in any vendor's spelling.
 *
 * Names are canonicalised before matching, because the separator is the vendor's choice and every
 * variant means the same thing to the destination: `X-Api-Key`, `X_API_KEY` and `X-ApiKey` are one
 * header wearing three costumes. Matching only the hyphenated lower-case form let the other two
 * through, which is a literal token in the free-form map with no lease, no grant check and — on a
 * read — no Approval.
 */
function isCredentialHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  if (CREDENTIAL_HEADERS.has(normalized)) return true;
  const canonical = name
    // `XApiKey` and `X-AuthToken` hide the word boundary in a case change.
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  return CREDENTIAL_WORDS.test(canonical);
}
const SAFE_RESPONSE_HEADERS = new Set([
  "content-length",
  "content-type",
  "etag",
  "last-modified",
  "link",
  "retry-after",
]);

/**
 * Leading bytes that identify a container no textual `content-type` can honestly describe.
 *
 * Matched against the *decoded* body, because the transport hands this Tool a string: it has
 * already run the bytes through a UTF-8 `TextDecoder`. A signature written as its raw bytes
 * therefore never matches — `89 50 4E 47` decodes to `U+FFFD` + `PNG`, not `\u0089PNG` — so each
 * pattern here is the text the decoder actually produces. The ASCII-only signatures survive
 * decoding unchanged; the rest are anchored on their printable tail after the replacement
 * character the invalid lead byte becomes.
 */
const BINARY_SIGNATURES = [
  "%PDF-",
  "PK\u0003\u0004",
  "\ufffdPNG",
  "GIF8",
  "OggS",
  "\u0000\u0000\u0001\u0000",
  "ID3",
  "\u0000\u0000\u0000",
];

/**
 * A decoded body that is mostly replacement characters was not text in any encoding.
 *
 * Catches every container whose signature is not ASCII — JPEG, gzip, most video — without needing
 * a pattern for each. Real text decodes to at most a stray `U+FFFD`; a binary file produces them
 * densely, because most byte sequences are not valid UTF-8.
 */
function decodesAsGarbage(sample: string): boolean {
  if (sample.length < 16) return false;
  let replacements = 0;
  for (const character of sample) if (character === "\ufffd") replacements += 1;
  return replacements / sample.length > 0.1;
}

interface CredentialInput {
  readonly secret: string;
  readonly header: string;
  readonly format?: string;
}

interface GraphqlInput {
  readonly document: string;
  readonly operationName?: string;
  readonly variables?: Readonly<Record<string, unknown>>;
}

interface ApiRequestInput {
  readonly url: string;
  readonly method: IntegrationHttpMethod;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly graphql?: GraphqlInput;
  readonly credential?: CredentialInput;
}

export interface NetworkToolContext {
  readonly userId: string;
  readonly runId: string;
  readonly activeSkillName?: string;
  readonly http: EgressHttpPort;
  readonly useCredential: <T>(
    input: {
      readonly userId: string;
      readonly runId: string;
      readonly activeSkillName?: string;
      readonly secret: string;
      readonly destination: string;
    },
    callback: (secret: string) => Promise<T>
  ) => Promise<T>;
  readonly assertSkillDestination: (destination: string) => void;
  /** Serves a repeat read of the same URL without touching the network; absent in a test. */
  readonly cache?: CachePort;
  /** The deadline this Tool call is held to, so an abandoned call abandons its socket too. */
  readonly abortSignal?: AbortSignal;
  /** Charges one network call to this Run; absent in a test or an unbudgeted host. */
  readonly spendBudget?: () => {
    readonly allowed: boolean;
    readonly spent: number;
    readonly limit: number;
  };
}

/**
 * The answer a Tool gives once its Run has spent its network budget.
 *
 * Phrased as an outcome rather than a validation error on purpose: the arguments were fine, so
 * asking the model to repair them would spend the repair budget reproducing this same answer.
 * What the model needs to know is that no further request will be sent, whatever it writes.
 */
function budgetExhausted(
  url: string,
  spend: { readonly spent: number; readonly limit: number }
): Record<string, unknown> {
  return {
    fetched: false,
    url,
    reason: "network_budget_exhausted",
    detail: `this Run has already made ${spend.spent - 1} network calls, its limit of ${spend.limit}; no further request will be sent, so do not retry — answer with what you already have or ask the person how to continue`,
  };
}

function asApiInput(args: unknown): ApiRequestInput {
  return args as ApiRequestInput;
}

function requestClassification(args: unknown) {
  const input = asApiInput(args);
  const destination = normalizedPublicUrl(input.url).origin;
  const graphqlKind =
    input.graphql === undefined
      ? undefined
      : classifyGraphqlOperation(input.graphql.document, input.graphql.operationName);
  if (graphqlKind === "subscription") throw new Error("GraphQL subscriptions are not supported");
  if (input.graphql !== undefined && input.method !== "POST") {
    throw new Error("GraphQL requests must use POST");
  }
  const mutating =
    graphqlKind === "mutation" ||
    (graphqlKind === undefined && !NETWORK_READ_METHODS.has(input.method));
  return {
    mutating,
    action: mutating ? "network.write" : "network.read",
    riskClass: mutating ? ("high" as const) : ("low" as const),
    idempotency: mutating ? ("reconcile" as const) : ("none" as const),
    destination,
    requiresApproval: mutating || input.credential !== undefined,
  };
}

function targetFor(args: unknown) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return [{ type: "network", id: "unresolved" }];
  }
  const rawUrl = (args as { readonly url?: unknown }).url;
  if (typeof rawUrl !== "string") return [{ type: "network", id: "unresolved" }];
  try {
    const url = normalizedPublicUrl(rawUrl);
    return [{ type: "network", id: url.host, domain: url.host }];
  } catch {
    return [{ type: "network", id: "unresolved" }];
  }
}

function safeHeaders(
  headers: Readonly<Record<string, string>> | undefined
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (TRANSPORT_HEADERS.has(name.toLowerCase())) {
      throw new Error(`header "${name}" is controlled by the transport`);
    }
    if (isCredentialHeader(name)) {
      throw new Error(
        `header "${name}" carries a credential: name a stored Credential in "credential" ` +
          "instead, so the Secret is leased, approved and audited"
      );
    }
    safe[name] = value;
  }
  return safe;
}

function projectedResult(result: GovernedHttpResult): unknown {
  if (result.kind !== "response") return result;
  const contentType = result.response.headers["content-type"];
  const denial = egressDenialReason(result.response.status, result.response.body);
  if (denial !== undefined) {
    return {
      kind: "destination_refused",
      url: result.url,
      reason: denial,
      detail: "this deployment refused the destination; the provider was never contacted",
    };
  }
  const rendered = renderWebContent(contentType, result.response.body, result.url);
  return {
    kind: "response",
    url: result.url,
    status: result.response.status,
    headers: Object.fromEntries(
      Object.entries(result.response.headers).filter(([name]) => {
        const normalized = name.toLowerCase();
        return SAFE_RESPONSE_HEADERS.has(normalized) || normalized.startsWith("x-ratelimit-");
      })
    ),
    format: rendered.format,
    body: rendered.text.slice(0, MAX_MODEL_CONTENT_CHARS),
    truncated: rendered.text.length > MAX_MODEL_CONTENT_CHARS,
  };
}

async function performApiRequest(
  input: ApiRequestInput,
  context: NetworkToolContext,
  credential?: string,
  mutating = false
): Promise<unknown> {
  context.assertSkillDestination(normalizedPublicUrl(input.url).origin);
  const headers = safeHeaders(input.headers);
  if (input.credential !== undefined) {
    if (TRANSPORT_HEADERS.has(input.credential.header.toLowerCase())) {
      throw new Error(
        `credential header "${input.credential.header}" is controlled by the transport`
      );
    }
    headers[input.credential.header] = (input.credential.format ?? "Bearer {token}").replace(
      "{token}",
      credential ?? ""
    );
  }
  const body =
    input.graphql === undefined
      ? input.body
      : {
          query: input.graphql.document,
          variables: input.graphql.variables ?? {},
          ...(input.graphql.operationName === undefined
            ? {}
            : { operationName: input.graphql.operationName }),
        };
  const result = await sendGovernedRequest(context.http, {
    url: input.url,
    method: input.method,
    headers,
    carriesCredential: input.credential !== undefined,
    assertDestination: context.assertSkillDestination,
    ...(body === undefined ? {} : { body }),
    ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
  });
  // A deadline or an abort says the answer never came back, not that the request never arrived.
  // Reporting that as a successful call would settle a mutating effect as confirmed, and the
  // model would be free to reissue a write the destination may already have performed.
  if (
    mutating &&
    result.kind === "response" &&
    mayHaveReachedDestination(result.response.status, result.response.body)
  ) {
    throw new IndeterminateRequestError(result.response.body);
  }
  return projectedResult(result);
}

/** A mutating request whose outcome the transport cannot report. Settles the effect ambiguous. */
class IndeterminateRequestError extends Error {
  constructor(readonly fault: unknown) {
    super("the request was sent but its outcome is unknown");
    this.name = "IndeterminateRequestError";
  }
}

function isReadableContentType(contentType: string): boolean {
  return (
    contentType.includes("text/") ||
    contentType.includes("application/json") ||
    contentType.includes("application/problem+json") ||
    contentType.includes("application/pdf")
  );
}

/** The media type alone, without the `charset` and boundary parameters that follow it. */
function mediaType(contentType: string | undefined): string {
  return contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
}

/** Why a document that is not text produced no text, in the shape a refused fetch already uses. */
const EXTRACTION_DETAIL: Readonly<Record<string, string>> = {
  no_text_layer: "this PDF has no text layer; it is a scan or pure artwork",
  unreadable: "this PDF could not be parsed; it may be corrupt or encrypted",
  image_not_extractable: "this URL served an image, which has no text to read",
  unsupported_media_type: "this URL served a document type with no readable text",
};

/**
 * Why this fetch produced no readable text, or `undefined` when it did. A refused fetch is an
 * answer the model has to reason about — a different URL, a different Tool, or telling the person
 * it cannot be read — so it is Tool output rather than a Tool error: an error reaches the model
 * stripped of the status, the destination and the server's own explanation, and the codes that
 * would carry it are the ones that spend the repair budget on arguments that were never wrong.
 */
function unroutableWebResult(
  requestedUrl: string,
  result: Exclude<GovernedHttpResult, { readonly kind: "response" }>
): Record<string, unknown> {
  if (result.kind === "cross_origin_redirect") {
    return {
      fetched: false,
      url: requestedUrl,
      reason: "cross_origin_redirect",
      detail: `${result.from} redirected to ${result.to}, which is a different site; fetch that URL directly if it is the one you want`,
    };
  }
  return {
    fetched: false,
    url: result.url,
    reason: "redirect_limit",
    detail: "this URL redirects in a loop and never settles on a page",
  };
}

function unreadableWebResponse(
  url: string,
  response: IntegrationHttpResponse
): Record<string, unknown> | undefined {
  const contentType = response.headers["content-type"]?.toLowerCase();
  const denial = egressDenialReason(response.status, response.body);
  if (denial !== undefined) {
    return {
      fetched: false,
      url,
      reason: "destination_refused",
      denial,
      detail: `this deployment refused the destination (${denial}); the site was never contacted`,
    };
  }
  if (response.status >= 400) {
    const served = renderWebContent(contentType, response.body, url).text.trim();
    return {
      fetched: false,
      url,
      status: response.status,
      reason: "http_error",
      detail:
        served.length === 0
          ? `the server answered ${response.status}`
          : `the server answered ${response.status}: ${served.slice(0, MAX_FAILURE_DETAIL_CHARS)}`,
    };
  }
  if (contentType !== undefined && !isReadableContentType(contentType)) {
    return {
      fetched: false,
      url,
      status: response.status,
      reason: "unsupported_content_type",
      detail: `this URL served ${contentType}, which has no readable text`,
    };
  }
  if (looksBinary(response.body)) {
    return {
      fetched: false,
      url,
      status: response.status,
      reason: "binary_content",
      detail: `this URL claimed ${contentType ?? "text"} but served binary data`,
    };
  }
  return undefined;
}

/**
 * Whether a body is binary despite a textual `content-type`.
 *
 * The declared type is the server's claim, and the allowlist above trusts it. A leading magic
 * number or a run of NUL bytes is the response's own contradiction of that claim, and admitting
 * it would put raw bytes through a Markdown renderer and into a prompt.
 */
function looksBinary(body: unknown): boolean {
  if (typeof body !== "string" || body.length === 0) return false;
  const head = body.slice(0, 512);
  if (head.includes("\u0000")) return true;
  if (BINARY_SIGNATURES.some((signature) => head.startsWith(signature))) return true;
  return decodesAsGarbage(head);
}

/** Whether this caller may read a cached page, which may sit at a redirected origin. */
function reachableCacheEntry(
  cached: Record<string, unknown>,
  context: NetworkToolContext
): boolean {
  const url = cached.url;
  if (typeof url !== "string") return false;
  try {
    context.assertSkillDestination(normalizedPublicUrl(url).origin);
    return true;
  } catch {
    return false;
  }
}

export const webFetchTool = defineApiTool<NetworkToolContext>({
  ...WEB_FETCH_TOOL_DECLARATION,
  tier: "platform",
  timeout: { wallClockMs: NETWORK_TOOL_TIMEOUT_MS },
  outputSchema: { type: "object", additionalProperties: true },
  authorization: {
    action: "network.read",
    resources: ["network"],
    targets: targetFor,
    dataClasses: ["source_content"],
  },
  classify: (args) => ({
    mutating: false,
    action: "network.read",
    destination: normalizedPublicUrl(asApiInput(args).url).origin,
  }),
  handler: async (args, context) => {
    const input = args as { readonly url: string };
    // The URL is the only part of this call the model can repair, so it is the only failure that
    // may spend the repair budget. Everything after it is the network's answer, and asking the
    // model to reword arguments that were never malformed just burns the budget on retries that
    // reproduce the same result.
    try {
      context.assertSkillDestination(normalizedPublicUrl(input.url).origin);
    } catch (error) {
      return err("validation_error", error instanceof Error ? error.message : "URL is invalid");
    }
    // Read the cache before charging the budget: that budget exists to stop this deployment
    // hammering someone else's service, and an answer served from memory sends them nothing.
    const cacheKey = `web_fetch:v1:${normalizedPublicUrl(input.url).href}`;
    const cached = await context.cache
      ?.get<Record<string, unknown>>(cacheKey)
      .catch(() => undefined);
    // A cached entry may have been fetched through a same-site redirect, so the origin it holds
    // is not always the origin just authorized. Whoever primed the cache had their own grants;
    // serving it unchecked would lend them to this caller. Anything unreadable counts as a miss.
    if (cached !== undefined && reachableCacheEntry(cached, context)) return ok(cached);

    const spend = context.spendBudget?.() ?? { allowed: true, spent: 0, limit: 0 };
    if (!spend.allowed) return ok(budgetExhausted(input.url, spend));
    try {
      const result = await sendGovernedRequest(context.http, {
        url: input.url,
        method: "GET",
        headers: {
          accept: "text/html, text/markdown, text/plain, application/json, application/pdf",
        },
        assertDestination: context.assertSkillDestination,
        // A PDF decoded as UTF-8 is destroyed before anything can read it, and `web_fetch` is
        // the one caller that can turn the bytes back into text.
        acceptBinary: true,
        ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
      });
      if (result.kind !== "response") return ok(unroutableWebResult(input.url, result));
      const unreadable = unreadableWebResponse(result.url, result.response);
      if (unreadable !== undefined) return ok(unreadable);
      const contentType = result.response.headers["content-type"]?.toLowerCase();
      const raw = result.response.body;
      let rendered: RenderedWebContent;
      if (raw instanceof Uint8Array) {
        const extracted = await extractText(mediaType(contentType), raw, {
          maxChars: MAX_MODEL_CONTENT_CHARS,
        });
        if (extracted.kind !== "text") {
          return ok({
            fetched: false,
            url: result.url,
            status: result.response.status,
            reason: "unsupported_content_type",
            detail: EXTRACTION_DETAIL[extracted.reason] ?? "this URL served no readable text",
          });
        }
        rendered = { format: "text", text: extracted.text, links: [] };
      } else {
        rendered = renderWebContent(contentType, raw, result.url);
      }
      const content = rendered.text.trim();
      if (content.length === 0) {
        return ok({
          fetched: false,
          url: result.url,
          status: result.response.status,
          reason: "empty_response",
          detail: "the destination answered but carried no readable text",
        });
      }
      const payload = {
        fetched: true,
        url: result.url,
        status: result.response.status,
        contentType: contentType ?? "unknown",
        format: rendered.format,
        content: content.slice(0, MAX_MODEL_CONTENT_CHARS),
        truncated: content.length > MAX_MODEL_CONTENT_CHARS,
        links: rendered.links,
      };
      await context.cache?.set(cacheKey, payload, WEB_FETCH_CACHE_TTL_MS).catch(() => undefined);
      return ok(payload);
    } catch (error) {
      return err("internal_error", error instanceof Error ? error.message : "web fetch failed");
    }
  },
});

export const apiRequestTool = defineApiTool<NetworkToolContext>({
  ...API_REQUEST_TOOL_DECLARATION,
  tier: "platform",
  timeout: { wallClockMs: NETWORK_TOOL_TIMEOUT_MS },
  outputSchema: { type: "object", additionalProperties: true },
  authorization: {
    action: "network.write",
    resources: ["network"],
    targets: targetFor,
    dataClasses: ["source_content"],
  },
  riskClass: "high",
  idempotency: "reconcile",
  retry: { maxAttempts: 1, safeToRetry: false },
  classify: requestClassification,
  handler: async (args, context) => {
    try {
      const input = asApiInput(args);
      const spend = context.spendBudget?.() ?? { allowed: true, spent: 0, limit: 0 };
      if (!spend.allowed) return ok(budgetExhausted(input.url, spend));
      const mutating = requestClassification(args).mutating;
      if (input.credential === undefined) {
        return ok(await performApiRequest(input, context, undefined, mutating));
      }
      const destination = normalizedPublicUrl(input.url).origin;
      const output = await context.useCredential(
        {
          userId: context.userId,
          runId: context.runId,
          activeSkillName: context.activeSkillName,
          secret: input.credential.secret,
          destination,
        },
        (secret) => performApiRequest(input, context, secret, mutating)
      );
      return ok(output);
    } catch (error) {
      if (error instanceof IndeterminateRequestError) {
        return err(
          "indeterminate",
          "The request was sent and no answer came back, so whether it took effect is unknown. Do not send it again; check the destination before acting."
        );
      }
      if (error instanceof SecretUnavailableError) {
        const input = asApiInput(args);
        const key = input.credential?.secret;
        return err(
          "credential_required",
          "This API request needs a Credential that is not configured. Ask an administrator to add it.",
          key === undefined
            ? "/business/secrets"
            : `/business/secrets?required=${encodeURIComponent(key)}`
        );
      }
      return err("write_denied", error instanceof Error ? error.message : "API request denied");
    }
  },
});

export const NETWORK_TOOLS = [webFetchTool, apiRequestTool] as const;
