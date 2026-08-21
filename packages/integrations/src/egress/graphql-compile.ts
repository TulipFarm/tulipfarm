import {
  canonicalHash,
  type ToolContractDefinition,
  type ToolContractSpec,
} from "@tulipfarm/schema";
import { assertPublicEgressUrl, EgressDestinationError } from "./destination";
import type { OpenApiEgressAuth } from "./openapi-compile";

export interface GraphqlEgressOperation {
  readonly name: string;
  readonly description: string;
  readonly operation: string;
  readonly document: string;
  readonly variables_schema: Record<string, unknown>;
}

export interface GraphqlEgress {
  readonly type: "graphql";
  readonly url: string;
  readonly operations?: readonly GraphqlEgressOperation[];
  readonly auth?: OpenApiEgressAuth;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface GraphqlOperationBinding {
  readonly url: string;
  readonly operation: string;
  readonly document: string;
  readonly mutating: boolean;
  readonly headers: Readonly<Record<string, string>>;
  readonly auth?: { readonly in: "header"; readonly header: string; readonly format: string };
}

export interface CompiledGraphqlTool {
  readonly name: string;
  readonly description: string;
  readonly toolId: string;
  readonly adapterRef: string;
  readonly mutating: boolean;
  readonly contract: ToolContractDefinition;
  readonly binding: GraphqlOperationBinding;
}

export type GraphqlCompileErrorCode =
  | "url_invalid"
  | "operation_invalid"
  | "operation_duplicate"
  | "tool_name_invalid"
  | "variables_schema_invalid";

export class GraphqlCompileError extends Error {
  readonly name = "GraphqlCompileError";

  constructor(
    readonly code: GraphqlCompileErrorCode,
    readonly detail?: string
  ) {
    super(detail === undefined ? `graphql_compile:${code}` : `graphql_compile:${code}:${detail}`);
  }
}

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,63}$/;
const OPERATION_NAME_RE = /^[_A-Za-z][_0-9A-Za-z]*$/;
const GRAPHQL_OPERATION_RE = /^(query|mutation)\s+([_A-Za-z][_0-9A-Za-z]*)\b/;
const ACTION_SLUG_PREFIX = "i_";

function actionSlug(slug: string): string {
  const normalized = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (normalized.length === 0) return `${ACTION_SLUG_PREFIX}${encodeSlug(slug) || "empty"}`;
  if (/^[a-z]/.test(normalized)) return normalized;
  return `${ACTION_SLUG_PREFIX}${normalized}`;
}

function encodeSlug(slug: string): string {
  return [...slug].map((char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

function operationKind(document: string, operation: string): "query" | "mutation" {
  const source = document.replace(/^\uFEFF/, "").replace(/^(?:\s|#[^\n]*(?:\n|$))*/, "");
  const match = source.match(GRAPHQL_OPERATION_RE);
  if (match?.[2] !== operation) {
    throw new GraphqlCompileError("operation_invalid", operation);
  }
  return match[1] as "query" | "mutation";
}

function resolveUrl(raw: string): string {
  if (/[{}]/.test(raw))
    throw new GraphqlCompileError("url_invalid", `${raw} (host must be literal)`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GraphqlCompileError("url_invalid", raw);
  }
  if (url.protocol !== "https:") {
    throw new GraphqlCompileError("url_invalid", `${raw} (must be https)`);
  }
  try {
    assertPublicEgressUrl(url, raw);
  } catch (error) {
    if (!(error instanceof EgressDestinationError)) throw error;
    throw new GraphqlCompileError("url_invalid", `${raw} (${error.denial})`);
  }
  return raw;
}

function authBinding(auth: OpenApiEgressAuth | undefined): GraphqlOperationBinding["auth"] {
  if (auth === undefined) return undefined;
  if (auth.in === "base_url") {
    throw new GraphqlCompileError("url_invalid", "GraphQL credentials must use a header");
  }
  return {
    in: "header",
    header: auth.header ?? "Authorization",
    format: auth.format ?? "Bearer {token}",
  };
}

function variablesSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema.type !== "object" || schema.additionalProperties !== false) {
    throw new GraphqlCompileError(
      "variables_schema_invalid",
      "variables_schema must be a closed object"
    );
  }
  return schema;
}

export interface CompileGraphqlEgressInput {
  readonly slug: string;
  readonly egress: GraphqlEgress | undefined;
}

/** Compiles fixed GraphQL documents; models control variables only, never provider operations. */
export function compileGraphqlEgress(input: CompileGraphqlEgressInput): CompiledGraphqlTool[] {
  const egress = input.egress;
  if (egress?.type !== "graphql") return [];
  const operations = egress.operations ?? [];
  if (operations.length === 0) return [];

  const url = resolveUrl(egress.url);
  const names = new Set<string>();
  const operationNames = new Set<string>();
  const headers = Object.freeze({ ...(egress.headers ?? {}) });
  const auth = authBinding(egress.auth);

  return operations.map((declared) => {
    if (!TOOL_NAME_RE.test(declared.name)) {
      throw new GraphqlCompileError("tool_name_invalid", declared.name);
    }
    if (!OPERATION_NAME_RE.test(declared.operation)) {
      throw new GraphqlCompileError("operation_invalid", declared.operation);
    }
    if (names.has(declared.name) || operationNames.has(declared.operation)) {
      throw new GraphqlCompileError("operation_duplicate", declared.name);
    }
    names.add(declared.name);
    operationNames.add(declared.operation);
    const mutating = operationKind(declared.document, declared.operation) === "mutation";
    const inputSchema = variablesSchema(declared.variables_schema);
    const toolId = `graphql.${input.slug}.${declared.name}`;
    const adapterRef = `graphql:${input.slug}:${declared.name}`;
    const spec: ToolContractSpec = {
      toolId,
      toolVersion: "1.0.0",
      action: `${actionSlug(input.slug)}.${declared.name}`,
      inputSchema,
      outputSchema: { type: "object", additionalProperties: true },
      riskClass: mutating ? "high" : "medium",
      mutating,
      allowedDestinations: [new URL(url).host],
      dataClasses: ["source_content"],
      idempotency: { strategy: mutating ? "reconcile" : "none" },
      retry: { maxAttempts: 1, safeToRetry: false },
      dryRun: false,
      adapter: { kind: "graphql", ref: adapterRef },
    };

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
          id: `graphql-${input.slug}-${declared.name}`,
          slug: `graphql-${input.slug}-${declared.name}`,
          displayName: declared.name,
          schemaVersion: 1,
          authoredVersion: 1,
          lifecycle: "published",
          publishedDigest: canonicalHash(spec),
        },
        spec,
      },
      binding: {
        url,
        operation: declared.operation,
        document: declared.document,
        mutating,
        headers,
        ...(auth === undefined ? {} : { auth }),
      },
    };
  });
}
