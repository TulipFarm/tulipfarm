import type { IntegrationHttpMethod } from "@tulipfarm/integrations";
import {
  classifyGraphqlOperation,
  type EgressHttpPort,
  type GovernedHttpResult,
  NETWORK_READ_METHODS,
  normalizedPublicUrl,
  readableWebContent,
  sendGovernedRequest,
} from "@tulipfarm/integrations";
import { API_REQUEST_TOOL_DECLARATION, WEB_FETCH_TOOL_DECLARATION } from "@tulipfarm/schema";
import { SecretUnavailableError } from "@tulipfarm/secrets";
import { defineApiTool, err, ok } from "@tulipfarm/tool-host";

const MAX_MODEL_CONTENT_CHARS = 100_000;
const FORBIDDEN_HEADERS = new Set([
  "connection",
  "content-length",
  "cookie",
  "host",
  "proxy-authorization",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
]);
const SAFE_RESPONSE_HEADERS = new Set([
  "content-length",
  "content-type",
  "etag",
  "last-modified",
  "link",
  "retry-after",
]);

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
  readonly extract: (input: {
    readonly url: string;
    readonly prompt: string;
    readonly content: string;
  }) => Promise<string>;
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
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      throw new Error(`header "${name}" is controlled by the transport`);
    }
    safe[name] = value;
  }
  return safe;
}

function projectedResult(result: GovernedHttpResult): unknown {
  if (result.kind !== "response") return result;
  const contentType = result.response.headers["content-type"];
  const rendered = readableWebContent(contentType, result.response.body);
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
    body: rendered.slice(0, MAX_MODEL_CONTENT_CHARS),
    truncated: rendered.length > MAX_MODEL_CONTENT_CHARS,
  };
}

async function performApiRequest(
  input: ApiRequestInput,
  context: NetworkToolContext,
  credential?: string
): Promise<unknown> {
  context.assertSkillDestination(normalizedPublicUrl(input.url).origin);
  const headers = safeHeaders(input.headers);
  if (input.credential !== undefined) {
    if (FORBIDDEN_HEADERS.has(input.credential.header.toLowerCase())) {
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
  return projectedResult(
    await sendGovernedRequest(context.http, {
      url: input.url,
      method: input.method,
      headers,
      ...(body === undefined ? {} : { body }),
    })
  );
}

export const webFetchTool = defineApiTool<NetworkToolContext>({
  ...WEB_FETCH_TOOL_DECLARATION,
  tier: "platform",
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
    try {
      const input = args as { readonly url: string; readonly prompt: string };
      context.assertSkillDestination(normalizedPublicUrl(input.url).origin);
      const result = await sendGovernedRequest(context.http, {
        url: input.url,
        method: "GET",
        headers: { accept: "text/html, text/markdown, text/plain, application/json" },
      });
      if (result.kind !== "response") return ok(result);
      const contentType = result.response.headers["content-type"]?.toLowerCase();
      if (
        contentType !== undefined &&
        !contentType.includes("text/") &&
        !contentType.includes("application/json") &&
        !contentType.includes("application/problem+json")
      ) {
        return err("validation_error", `unsupported web content type: ${contentType}`);
      }
      const content = readableWebContent(contentType, result.response.body).slice(
        0,
        MAX_MODEL_CONTENT_CHARS
      );
      const extracted = await context.extract({ url: result.url, prompt: input.prompt, content });
      return ok({
        url: result.url,
        status: result.response.status,
        contentType: contentType ?? "unknown",
        extracted,
      });
    } catch (error) {
      return err("validation_error", error instanceof Error ? error.message : "web fetch failed");
    }
  },
});

export const apiRequestTool = defineApiTool<NetworkToolContext>({
  ...API_REQUEST_TOOL_DECLARATION,
  tier: "platform",
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
      if (input.credential === undefined) return ok(await performApiRequest(input, context));
      const destination = normalizedPublicUrl(input.url).origin;
      const output = await context.useCredential(
        {
          userId: context.userId,
          runId: context.runId,
          activeSkillName: context.activeSkillName,
          secret: input.credential.secret,
          destination,
        },
        (secret) => performApiRequest(input, context, secret)
      );
      return ok(output);
    } catch (error) {
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
