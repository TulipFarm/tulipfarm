import {
  canonicalHash,
  type ToolContractDefinition,
  type ToolContractSpec,
} from "@tulipfarm/schema";
import type { IntegrationHttpMethod } from "../http";

/**
 * The `egress` block this compiler is given, declared here rather than imported from
 * `@tulipfarm/soul`.
 *
 * Soul owns the manifest format, but a manifest is a TulipFarm concept and this is a generic
 * OpenAPI-to-Tool compiler — it reads nothing else from a manifest, so depending on that type
 * would couple a provider-neutral adapter to the artifact layer above it (see
 * `docs/architecture/dependency-rules.md`). These are structurally compatible with soul's
 * `EgressConfig`, so a caller that has one passes `manifest.egress` unchanged and any drift
 * surfaces as a compile error where the two meet.
 */
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

/** One OpenAPI operation published as an agent-callable Tool. */
export interface OpenApiEgressOperation {
  /** `operationId` in the referenced spec. */
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
 * Compiles a manifest's `egress: { type: "openapi" }` into executable Tool contracts.
 *
 * This is the runtime counterpart to `../import/openapi.ts`. That module turns a discovered spec
 * into a *governed proposal* an operator reviews before anything is published; this one compiles
 * an already-installed manifest's own declaration into contracts the Tool Broker dispatches. The
 * schema derivation is deliberately similar and deliberately separate: the authoring path should
 * refuse anything it cannot describe precisely, while the runtime path has to cope with the real
 * specs providers actually publish.
 *
 * The two places they diverge, and why:
 *
 *  - **`$ref` is resolved here.** `ToolRegistry.register` compiles every `inputSchema` with AJV, so
 *    a surviving `#/components/schemas/...` pointer would throw at registration time and take down
 *    an unrelated integration's tools with it. Authoring can hand a reviewer a `$ref`; execution
 *    cannot.
 *  - **A missing response schema is not fatal here.** Plenty of real operations document no JSON
 *    response body. Refusing to compile those would let a provider's documentation quality decide
 *    whether an operator may use it, so the output schema falls back to permissive.
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

const PERMISSIVE_SCHEMA = { type: "object", additionalProperties: true } as const;

/**
 * RFC 3986 `pchar` minus `%`: the characters a value may contain when it is placed in the URL
 * path. Excluding `/`, `?`, `#` and `%` is the point — those are what would let a credential or a
 * connection value add a path segment, start a query, or smuggle an encoded character past this
 * check.
 */
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
  /**
   * The contract's own declaration, carried here so failure classification never re-guesses it
   * from the HTTP verb — a manifest may mark a POST search as non-mutating, and whether a failed
   * call is ambiguous depends on that answer rather than on the method.
   */
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
  /** Name agents call. */
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
  /** Integration slug — namespaces tool ids so two integrations may publish the same tool name. */
  readonly slug: string;
  /** The integration's `egress` block. A non-openapi kind compiles to no Tools. */
  readonly egress: EgressInput | undefined;
  /** The parsed spec document named by `egress.spec`. */
  readonly document: unknown;
  /**
   * Non-secret connection env, used to fill `{VAR}` placeholders in `base_url`'s path.
   *
   * Some providers put a per-install identifier in the address rather than a header — Atlassian
   * Cloud is `/ex/confluence/<cloud-id>/…`. Resolved at compile rather than dispatch so the
   * compiled binding holds a finished URL, and so a manifest naming a var the operator never
   * supplied fails once, loudly, instead of on every call.
   */
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

/**
 * Inlines local `#/...` pointers.
 *
 * Remote pointers are replaced with a permissive schema rather than fetched: dereferencing one
 * would have the host request a URL a third-party spec chose, during tool registration, which is
 * exactly the authority the declarative framework exists to withhold.
 *
 * A pointer already open on the current path is likewise replaced — a self-referential type (a
 * Notion block containing blocks) is legitimate and common, and the alternative is refusing to
 * compile it at all.
 */
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

/**
 * The URL credentials are actually sent to.
 *
 * Checked here and not only in `integration-trust` because the spec file that usually supplies it
 * is never read by that validator: a manifest can pass an install-time review and still point its
 * `servers` entry anywhere.
 */
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
  return declared.replace(/\/+$/, "");
}

/**
 * Fill `{VAR}` placeholders in a base URL from non-secret connection env.
 *
 * `{token}` is left alone — that one is the credential, substituted at dispatch so the compiled
 * binding never holds a secret. Everything else must resolve here: a placeholder that survived
 * would be sent literally, asking the provider for a site named `{CONFLUENCE_CLOUD_ID}`.
 *
 * Values are validated as path segments rather than percent-encoded, for the same reason the
 * credential is: excluding `/ ? # %` is precisely what stops a connection value from adding a path
 * segment, smuggling a query, or escaping into a different resource. The host was already required
 * to be literal, so the destination allow-list still pins one origin.
 */
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

/**
 * Reconcile where the credential is declared to go with what the base URL actually contains.
 *
 * Both directions are errors, and both are silent failures if unchecked: a `base_url` placement
 * with no `{token}` sends every call unauthenticated, and a leftover `{token}` under header
 * placement puts the literal string `%7Btoken%7D` in the path — a 404 that looks like a provider
 * problem. The host is already required to be literal by `resolveBaseUrl`, so `{token}` can only
 * ever land in the path and can never move the destination.
 */
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
    action: operation.operationId,
    inputSchema,
    outputSchema: deriveOutput(operation, root),
    riskClass: mutating ? "high" : "medium",
    mutating,
    allowedDestinations: [new URL(baseUrl).host],
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
