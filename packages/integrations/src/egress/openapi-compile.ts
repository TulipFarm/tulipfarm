import {
  canonicalHash,
  type ToolContractDefinition,
  type ToolContractSpec,
} from "@tulipfarm/schema";
import type { IntegrationHttpMethod } from "../http";
import { assertPublicEgressUrl, EgressDestinationError } from "./destination";

/** Structural copy of Soul `EgressConfig`; avoids coupling this provider-neutral compiler. */
export interface OpenApiEgressAuth {
  /** Connection env var holding the credential. Sealed values resolve through the secrets store. */
  readonly token_env: string;
  /** Where the credential is placed. Default `header`. */
  readonly in?: "header" | "base_url";
  /** Header the credential rides in. Ignored when `in` is `base_url`. */
  readonly header?: string;
  /** Value template; var: `{token}`. Ignored when `in` is `base_url`. */
  readonly format?: string;
}

export interface OpenApiEgressOperation {
  readonly operation: string;
  /** Tool name agents call. Namespaced by slug, so it need not be unique across integrations. */
  readonly name: string;
  /** What the agent is told this does. The model picks tools from this, so it is load-bearing. */
  readonly description: string;
  /** Overrides the default (any method other than GET is mutating). */
  readonly mutating?: boolean;
}

export interface OpenApiEgress {
  readonly type: "openapi";
  readonly spec: string;
  readonly operations?: readonly OpenApiEgressOperation[];
  readonly base_url?: string;
  readonly auth?: OpenApiEgressAuth;
  readonly headers?: Record<string, string>;
}

/**
 * Egress kinds this compiler does not handle, accepted so a caller can pass any integration's
 * `egress` block unchanged and get an empty result rather than having to discriminate first.
 */
export interface UnsupportedEgress {
  readonly type: "mcp" | "ts-code" | "none";
}

export type EgressInput = OpenApiEgress | UnsupportedEgress;

/**
 * Compiles installed OpenAPI egress into Tool contracts; resolves all `$ref`s and permits missing
 * response schemas so malformed provider docs cannot break unrelated Tool registration.
 */

const HTTP_METHODS = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
} as const satisfies Record<string, IntegrationHttpMethod>;

type SpecMethod = keyof typeof HTTP_METHODS;

const SPEC_METHODS = Object.keys(HTTP_METHODS) as SpecMethod[];

/** Agent-facing tool names are identifiers, not prose — the model calls them verbatim. */
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,63}$/;
const ACTION_SLUG_PREFIX = "i_";

const PERMISSIVE_SCHEMA = { type: "object", additionalProperties: true } as const;

/** Path placeholder values exclude `/`, `?`, `#`, and `%` to prevent URL escape. */
export const PATH_SEGMENT_RE = /^[A-Za-z0-9\-._~!$&'()*+,;=:@]+$/;

export type EgressCompileErrorCode =
  | "spec_invalid"
  | "base_url_missing"
  | "base_url_invalid"
  | "auth_placement_invalid"
  | "operation_not_found"
  | "tool_name_invalid"
  | "duplicate_tool";

export class EgressCompileError extends Error {
  readonly name = "EgressCompileError";

  constructor(
    readonly code: EgressCompileErrorCode,
    readonly detail?: string
  ) {
    super(detail === undefined ? `egress_compile:${code}` : `egress_compile:${code}:${detail}`);
  }
}

/** Where one flattened input property belongs on the wire. */
export interface OpenApiParamBinding {
  readonly name: string;
  readonly in: "path" | "query" | "header";
}

/** Everything the adapter needs to turn validated arguments into one HTTP request. */
export interface OpenApiOperationBinding {
  readonly method: IntegrationHttpMethod;
  /** Origin plus any prefix, no trailing slash. */
  readonly baseUrl: string;
  /** Spec path with `{param}` placeholders intact. */
  readonly pathTemplate: string;
  /** Failure classification uses this manifest value, not the HTTP verb. */
  readonly mutating: boolean;
  readonly params: readonly OpenApiParamBinding[];
  /** Whether a JSON request body is built from the `body` argument. */
  readonly hasBody: boolean;
  /** Static headers from the manifest (e.g. Notion's required `Notion-Version`). */
  readonly headers: Readonly<Record<string, string>>;
  /**
   * Absent when the manifest declares no credential — a genuinely public API. `base_url` carries
   * no header/format: the credential replaces `{token}` in `baseUrl` instead of riding a header.
   */
  readonly auth?:
    | { readonly in: "header"; readonly header: string; readonly format: string }
    | { readonly in: "base_url" };
}

export interface CompiledEgressTool {
  readonly name: string;
  readonly description: string;
  readonly toolId: string;
  /** Key the dispatcher's adapter map uses (`ToolContractSpec.adapter.ref`). */
  readonly adapterRef: string;
  readonly mutating: boolean;
  readonly contract: ToolContractDefinition;
  readonly binding: OpenApiOperationBinding;
}

export interface CompileOpenApiEgressInput {
  readonly slug: string;
  /** The integration's `egress` block. A non-openapi kind compiles to no Tools. */
  readonly egress: EgressInput | undefined;
  readonly document: unknown;
  /** Non-secret path env resolved at compile time; missing vars fail once, not per call. */
  readonly env?: Record<string, string>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Inline local `$ref`s; remote or recursive refs become permissive schemas, never fetches. */
function resolveRefs(
  node: unknown,
  root: Record<string, unknown>,
  seen: readonly string[]
): unknown {
  if (Array.isArray(node)) return node.map((item) => resolveRefs(item, root, seen));
  const object = record(node);
  if (object === undefined) return node;

  const ref = object.$ref;
  if (typeof ref === "string") {
    if (!ref.startsWith("#/") || seen.includes(ref)) return { ...PERMISSIVE_SCHEMA };
    let target: unknown = root;
    for (const rawSegment of ref.slice(2).split("/")) {
      const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
      const container = record(target);
      if (container === undefined) return { ...PERMISSIVE_SCHEMA };
      target = container[segment];
    }
    if (target === undefined) return { ...PERMISSIVE_SCHEMA };
    return resolveRefs(target, root, [...seen, ref]);
  }

  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) {
    resolved[key] = resolveRefs(value, root, seen);
  }
  return resolved;
}

interface SpecOperation {
  readonly method: SpecMethod;
  readonly path: string;
  readonly operationId: string;
  readonly node: Record<string, unknown>;
  /** Path-level parameters, which apply to every operation under that path. */
  readonly pathParameters: readonly unknown[];
}

function specOperations(document: unknown): Map<string, SpecOperation> {
  const root = record(document);
  if (root === undefined || typeof root.openapi !== "string" || !root.openapi.startsWith("3.")) {
    throw new EgressCompileError("spec_invalid", "expected an OpenAPI 3.x document");
  }
  const paths = record(root.paths);
  if (paths === undefined) throw new EgressCompileError("spec_invalid", "no paths");

  const found = new Map<string, SpecOperation>();
  for (const [path, pathValue] of Object.entries(paths)) {
    const pathItem = record(pathValue);
    if (pathItem === undefined) continue;
    const pathParameters = toArray(pathItem.parameters);
    for (const method of SPEC_METHODS) {
      const node = record(pathItem[method]);
      if (node === undefined || typeof node.operationId !== "string") continue;
      found.set(node.operationId, {
        method,
        path,
        operationId: node.operationId,
        node,
        pathParameters,
      });
    }
  }
  return found;
}

function firstServerUrl(document: unknown): string | undefined {
  const servers = record(document)?.servers;
  if (!Array.isArray(servers)) return undefined;
  const url = record(servers[0])?.url;
  return typeof url === "string" ? url : undefined;
}

/** Resolve and require the credential destination URL to be HTTPS with a literal public host. */
function resolveBaseUrl(document: unknown, override: string | undefined): string {
  const declared = override ?? firstServerUrl(document);
  if (declared === undefined) {
    throw new EgressCompileError("base_url_missing", "no egress.base_url and no servers[0].url");
  }
  let parsed: URL;
  try {
    parsed = new URL(declared);
  } catch {
    throw new EgressCompileError("base_url_invalid", declared);
  }
  if (parsed.protocol !== "https:") {
    throw new EgressCompileError("base_url_invalid", `${declared} (must be https)`);
  }
  if (/[{}]/.test(parsed.host)) {
    throw new EgressCompileError("base_url_invalid", `${declared} (host must be literal)`);
  }
  // A manifest is authored from chat, so its destination is untrusted and is about to be spent
  // against with the deployment's credential. Refuse an install that points inward rather than
  // discovering it on the first call.
  try {
    assertPublicEgressUrl(parsed, declared);
  } catch (error) {
    if (!(error instanceof EgressDestinationError)) throw error;
    throw new EgressCompileError("base_url_invalid", `${declared} (${error.denial})`);
  }
  return declared.replace(/\/+$/, "");
}

/** Resolve non-secret `{VAR}` path placeholders; leave `{token}` secret-only for dispatch. */
function resolveEnvPlaceholders(
  baseUrl: string,
  env: Record<string, string>,
  tokenEnv: string | undefined
): string {
  return baseUrl.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
    if (name === "token") return match;
    if (name === tokenEnv) {
      throw new EgressCompileError(
        "base_url_invalid",
        `${baseUrl} (name the credential placeholder {token}, not {${name}})`
      );
    }
    const value = env[name];
    if (value === undefined) {
      throw new EgressCompileError(
        "base_url_invalid",
        `${baseUrl} (no connection value for ${name})`
      );
    }
    if (!PATH_SEGMENT_RE.test(value)) {
      throw new EgressCompileError(
        "base_url_invalid",
        `${baseUrl} (${name} is not a path segment)`
      );
    }
    return value;
  });
}

/** `base_url` auth must contain `{token}`; header auth must not leave `{token}` in the URL. */
function assertAuthPlacement(baseUrl: string, auth: OpenApiEgressAuth | undefined): void {
  const hasPlaceholder = baseUrl.includes("{token}");
  if (auth?.in === "base_url") {
    if (!hasPlaceholder) {
      throw new EgressCompileError("auth_placement_invalid", "base_url has no {token}");
    }
    return;
  }
  if (hasPlaceholder) {
    throw new EgressCompileError(
      "auth_placement_invalid",
      'base_url has {token} but auth.in is not "base_url"'
    );
  }
}

interface DerivedInput {
  readonly inputSchema: Record<string, unknown>;
  readonly params: readonly OpenApiParamBinding[];
  readonly hasBody: boolean;
}

function deriveInput(operation: SpecOperation, root: Record<string, unknown>): DerivedInput {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const params: OpenApiParamBinding[] = [];

  for (const candidate of [...operation.pathParameters, ...toArray(operation.node.parameters)]) {
    const parameter = record(resolveRefs(candidate, root, []));
    const name = parameter?.name;
    const location = parameter?.in;
    if (typeof name !== "string") continue;
    // `cookie` is the remaining OpenAPI location. Nothing here sends cookies, and dropping such a
    // parameter is safer than guessing somewhere else to put its value.
    if (location !== "path" && location !== "query" && location !== "header") continue;
    properties[name] = record(parameter?.schema) ?? { type: "string" };
    // A path placeholder with no value cannot produce a URL, so it is required whatever the spec
    // says — some specs omit `required` on path parameters even though OpenAPI mandates it.
    if (parameter?.required === true || location === "path") required.push(name);
    params.push({ name, in: location });
  }

  const requestBody = record(resolveRefs(operation.node.requestBody, root, []));
  const bodySchema = record(record(record(requestBody?.content)?.["application/json"])?.schema);
  if (bodySchema !== undefined) {
    // Nested under `body` rather than merged into the top level: a body property and a path or
    // query parameter can share a name (Notion's `page_id` is both), and merging would silently
    // drop one. The model fills a nested object as readily as a flat one.
    properties.body = bodySchema;
    if (requestBody?.required === true) required.push("body");
  }

  return {
    inputSchema: {
      type: "object",
      additionalProperties: false,
      ...(required.length === 0 ? {} : { required: [...new Set(required)] }),
      properties,
    },
    params,
    hasBody: bodySchema !== undefined,
  };
}

function deriveOutput(
  operation: SpecOperation,
  root: Record<string, unknown>
): Record<string, unknown> {
  const responses = record(operation.node.responses);
  if (responses === undefined) return { ...PERMISSIVE_SCHEMA };
  for (const [status, responseValue] of Object.entries(responses)) {
    if (!/^2\d\d$/.test(status)) continue;
    const response = record(resolveRefs(responseValue, root, []));
    const schema = record(record(record(response?.content)?.["application/json"])?.schema);
    if (schema !== undefined) return schema;
  }
  return { ...PERMISSIVE_SCHEMA };
}

function authBinding(auth: OpenApiEgressAuth | undefined): OpenApiOperationBinding["auth"] {
  if (auth === undefined) return undefined;
  if (auth.in === "base_url") return { in: "base_url" };
  return {
    in: "header",
    header: auth.header ?? "Authorization",
    format: auth.format ?? "Bearer {token}",
  };
}

function encodeActionSlug(slug: string): string {
  return [...slug].map((char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

function actionSlug(slug: string): string {
  const normalized = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (normalized.length === 0) return `${ACTION_SLUG_PREFIX}${encodeActionSlug(slug) || "empty"}`;
  if (/^[a-z]/.test(normalized)) return normalized;
  return `${ACTION_SLUG_PREFIX}${normalized}`;
}

function compileOne(
  slug: string,
  declared: OpenApiEgressOperation,
  operation: SpecOperation,
  root: Record<string, unknown>,
  baseUrl: string,
  headers: Readonly<Record<string, string>>,
  auth: OpenApiEgressAuth | undefined
): CompiledEgressTool {
  if (!TOOL_NAME_RE.test(declared.name)) {
    throw new EgressCompileError("tool_name_invalid", declared.name);
  }
  const { inputSchema, params, hasBody } = deriveInput(operation, root);
  const mutating = declared.mutating ?? operation.method !== "get";
  const toolId = `openapi.${slug}.${declared.name}`;
  const adapterRef = `openapi:${slug}:${declared.name}`;

  const spec: ToolContractSpec = {
    toolId,
    toolVersion: "1.0.0",
    action: `${actionSlug(slug)}.${declared.name}`,
    inputSchema,
    outputSchema: deriveOutput(operation, root),
    riskClass: mutating ? "high" : "medium",
    mutating,
    allowedDestinations: [new URL(baseUrl).host],
    // A compiled tool reaches a third-party API, so the data it moves is that provider's content —
    // the same class the hand-written GitHub, Slack and Jira contracts already declare for exactly
    // this. It is not a placeholder: `checkDlpBoundary` denies `unclassified_data` before it reads
    // a single rule, so a compiler that omits this emits tools no authority can ever run.
    dataClasses: ["source_content"],
    idempotency: { strategy: mutating ? "reconcile" : "none" },
    retry: { maxAttempts: 1, safeToRetry: false },
    dryRun: false,
    adapter: { kind: "openapi", ref: adapterRef },
  };

  const bound = authBinding(auth);

  return {
    name: declared.name,
    description: declared.description,
    toolId,
    adapterRef,
    mutating,
    contract: {
      apiVersion: "tulipfarm.ai/v1",
      kind: "ToolContract",
      metadata: {
        id: `openapi-${slug}-${declared.name}`,
        slug: `openapi-${slug}-${declared.name}`,
        displayName: declared.name,
        schemaVersion: 1,
        authoredVersion: 1,
        // Installing the manifest is the publication event: an operator accepted this declaration,
        // and the digest pins the exact shape they accepted.
        lifecycle: "published",
        publishedDigest: canonicalHash(spec),
      },
      spec,
    },
    binding: {
      method: HTTP_METHODS[operation.method],
      baseUrl,
      pathTemplate: operation.path,
      mutating,
      params,
      hasBody,
      headers,
      ...(bound === undefined ? {} : { auth: bound }),
    },
  };
}

/**
 * Returns the Tools this manifest publishes. An empty result is normal rather than an error: an
 * integration may exist purely for ingress, or declare no operations yet.
 */
export function compileOpenApiEgress(input: CompileOpenApiEgressInput): CompiledEgressTool[] {
  const egress = input.egress;
  if (egress?.type !== "openapi") return [];
  const declaredOperations = egress.operations ?? [];
  if (declaredOperations.length === 0) return [];

  const root = record(input.document);
  if (root === undefined) throw new EgressCompileError("spec_invalid", "not an object");

  // Shape first, then fields: reading `servers` out of a document that was never an OpenAPI 3 spec
  // reports a missing base URL when the real problem is the spec itself.
  const available = specOperations(input.document);
  const baseUrl = resolveEnvPlaceholders(
    resolveBaseUrl(input.document, egress.base_url),
    input.env ?? {},
    egress.auth?.token_env
  );
  assertAuthPlacement(baseUrl, egress.auth);
  const headers = Object.freeze({ ...(egress.headers ?? {}) });

  const compiled: CompiledEgressTool[] = [];
  const names = new Set<string>();
  for (const declared of declaredOperations) {
    const operation = available.get(declared.operation);
    if (operation === undefined) {
      throw new EgressCompileError("operation_not_found", declared.operation);
    }
    if (names.has(declared.name)) throw new EgressCompileError("duplicate_tool", declared.name);
    names.add(declared.name);
    compiled.push(compileOne(input.slug, declared, operation, root, baseUrl, headers, egress.auth));
  }
  return compiled;
}
