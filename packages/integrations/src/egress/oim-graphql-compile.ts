import {
  canonicalHash,
  type OimManifest,
  type OimOperation,
  oimGraphqlOperationKind,
  oimToolId,
  type ToolContractDefinition,
  type ToolContractSpec,
} from "@tulipfarm/schema";
import { assertPublicEgressUrl, EgressDestinationError } from "./destination";
import type { GraphqlOperationBinding } from "./graphql-compile";
import {
  type OimCompileOptions,
  type OimConfiguration,
  OimHttpCompileError,
  resolveOimUrlTemplate,
} from "./oim-http-compile";
import { NEXT_PAGE_TOKEN_PROPERTY, PAGE_TOKEN_ARGUMENT } from "./oim-pagination";

export type OimGraphqlCompileErrorCode =
  | "source_not_graphql"
  | "destination_invalid"
  | "credential_injection_missing"
  /** A credential placed in the query string, which a GraphQL POST has no way to carry safely. */
  | "credential_injection_unsupported"
  /** The manifest declared no content for the document file the operation names. */
  | "document_missing"
  /** The document does not define the named operation exactly once. */
  | "operation_not_found"
  /** Variables that are not a closed object, which would let an Agent send undeclared ones. */
  | "variables_schema_invalid"
  /** A `query` declared as a write, or a `mutation` declared as a read. */
  | "effect_mismatch"
  | "origin_unconfigured"
  | "origin_not_allowed"
  | "response_mode_unsupported"
  | "pagination_unsupported"
  | "pagination_variable_missing";

/**
 * A GraphQL operation reaches one endpoint by POST, so a credential has nowhere to go but a header.
 * Manifest validation already refuses the alternatives; this keeps the compiler total.
 */
function graphqlCredentialHeader(operation: OimOperation): string {
  const injection = operation.credentialInjection;
  if (injection === undefined || injection.in !== "header") {
    throw new OimGraphqlCompileError("credential_injection_missing", operation.id);
  }
  return injection.name;
}

export class OimGraphqlCompileError extends Error {
  readonly name = "OimGraphqlCompileError";

  constructor(
    readonly code: OimGraphqlCompileErrorCode,
    readonly operationId: string
  ) {
    super(`oim_graphql_compile:${code}:${operationId}`);
  }
}

export interface CompiledOimGraphqlTool {
  readonly operation: OimOperation;
  /** Structural parity with `CompiledOimHttpTool` so one Tool builder serves both compilers. */
  readonly name: string;
  readonly description: string;
  readonly mutating: boolean;
  readonly toolId: string;
  readonly adapterRef: string;
  readonly contract: ToolContractDefinition;
  readonly binding: GraphqlOperationBinding;
  readonly projection?: readonly string[];
  readonly pagination?: NonNullable<OimOperation["pagination"]>;
}

const MUTATING_EFFECTS = new Set<OimOperation["effect"]>([
  "create",
  "update",
  "delete",
  "send",
  "admin",
]);

function riskClass(effect: OimOperation["effect"]): ToolContractSpec["riskClass"] {
  if (effect === "read") return "low";
  if (effect === "sensitive_read" || effect === "create" || effect === "update") return "medium";
  return "high";
}

function variablesSchema(operation: OimOperation): Record<string, unknown> {
  const declared = operation.requestSchema;
  if (declared === undefined) {
    return { type: "object", properties: {}, additionalProperties: false };
  }
  const schema = declared as Record<string, unknown>;
  if (schema.type !== "object" || schema.additionalProperties !== false) {
    throw new OimGraphqlCompileError("variables_schema_invalid", operation.id);
  }
  const pagination = operation.pagination;
  if (pagination === undefined) return schema;
  if (pagination.type === "link" || pagination.type === "body_cursor") {
    throw new OimGraphqlCompileError("pagination_unsupported", operation.id);
  }
  const properties = { ...((schema.properties as Record<string, unknown>) ?? {}) };
  delete properties[pagination.requestParameter];
  properties[PAGE_TOKEN_ARGUMENT] = {
    type: "string",
    maxLength: 4096,
    description: "Opaque continuation token from a previous page. Omit for the first page.",
  };
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name) => name !== pagination.requestParameter)
    : [];
  const { required: _required, ...rest } = schema;
  return { ...rest, properties, ...(required.length === 0 ? {} : { required }) };
}

function outputSchema(operation: OimOperation): Record<string, unknown> {
  if (operation.response.mode === "binary") {
    throw new OimGraphqlCompileError("response_mode_unsupported", operation.id);
  }
  const schema = operation.response.schema as Record<string, unknown>;
  if (operation.pagination === undefined) return schema;
  return {
    ...schema,
    properties: {
      ...((schema.properties as Record<string, unknown>) ?? {}),
      [NEXT_PAGE_TOKEN_PROPERTY]: { type: "string" },
    },
  };
}

function destinationHost(url: string, operationId: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
    assertPublicEgressUrl(parsed, url);
  } catch (error) {
    if (error instanceof EgressDestinationError || error instanceof TypeError) {
      throw new OimGraphqlCompileError("destination_invalid", operationId);
    }
    throw error;
  }
  if (parsed.protocol !== "https:") {
    throw new OimGraphqlCompileError("destination_invalid", operationId);
  }
  return parsed.host;
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compiles GraphQL operations whose document text is fixed by the package.
 *
 * Agents supply variables only. The document, the operation name and the endpoint all come from
 * the manifest, so no Agent argument can widen what the call selects or mutates.
 */
export function compileOimGraphqlOperations(
  manifest: OimManifest,
  /** Declared companion contents, keyed by the path the manifest's `files` entry names. */
  documents: ReadonlyMap<string, string> = new Map(),
  configuration: OimConfiguration = {},
  options: OimCompileOptions = {}
): CompiledOimGraphqlTool[] {
  return manifest.operations
    .filter((operation) => operation.source.type === "graphql")
    .map((operation) => {
      const { source } = operation;
      if (source.type !== "graphql") {
        throw new OimGraphqlCompileError("source_not_graphql", operation.id);
      }
      if (operation.response.mode === "binary") {
        throw new OimGraphqlCompileError("response_mode_unsupported", operation.id);
      }
      if (operation.credentialSlot !== undefined && operation.credentialInjection === undefined) {
        throw new OimGraphqlCompileError("credential_injection_missing", operation.id);
      }
      if (
        operation.credentialInjection?.in === "query" ||
        operation.secondaryCredential !== undefined
      ) {
        throw new OimGraphqlCompileError("credential_injection_unsupported", operation.id);
      }
      const document = documents.get(source.documentFile);
      if (document === undefined) {
        throw new OimGraphqlCompileError("document_missing", operation.id);
      }
      const kind = oimGraphqlOperationKind(document, source.operation);
      if (kind === undefined || kind === "subscription") {
        throw new OimGraphqlCompileError("operation_not_found", operation.id);
      }
      if (
        operation.pagination !== undefined &&
        operation.pagination.type !== "link" &&
        operation.pagination.type !== "body_cursor" &&
        !new RegExp(`\\$${escapedRegExp(operation.pagination.requestParameter)}\\b`).test(document)
      ) {
        throw new OimGraphqlCompileError("pagination_variable_missing", operation.id);
      }
      const mutating = MUTATING_EFFECTS.has(operation.effect);
      if ((kind === "mutation") !== mutating) {
        throw new OimGraphqlCompileError("effect_mismatch", operation.id);
      }
      let url: string;
      try {
        url = resolveOimUrlTemplate(manifest, operation, source.url, configuration, options);
      } catch (error) {
        if (
          error instanceof OimHttpCompileError &&
          (error.code === "destination_invalid" ||
            error.code === "origin_unconfigured" ||
            error.code === "origin_not_allowed")
        ) {
          throw new OimGraphqlCompileError(error.code, operation.id);
        }
        throw error;
      }
      const host = destinationHost(url, operation.id);
      const toolId = oimToolId(manifest, operation.id);
      const adapterRef = `oim-graphql:${canonicalHash({ toolId, operation, document }).slice(0, 32)}`;
      const spec: ToolContractSpec = {
        toolId,
        toolVersion: manifest.metadata.version,
        description: operation.description,
        action: `integration.${manifest.metadata.id}.${operation.name}`,
        inputSchema: variablesSchema(operation),
        outputSchema: outputSchema(operation),
        riskClass: riskClass(operation.effect),
        mutating,
        allowedDestinations: [host],
        dataClasses: ["source_content"],
        dryRun: false,
        idempotency: { strategy: mutating ? "reconcile" : "none" },
        retry: { maxAttempts: 3, safeToRetry: true },
        adapter: { kind: "graphql", ref: adapterRef },
      };
      return {
        operation,
        name: operation.name,
        description: operation.description,
        mutating,
        toolId,
        adapterRef,
        contract: {
          apiVersion: "tulipfarm.ai/v1",
          kind: "ToolContract",
          metadata: {
            id: `oim-graphql-${canonicalHash(toolId).slice(0, 23)}`,
            slug: `${manifest.metadata.id}-${operation.name}`,
            displayName: operation.name,
            schemaVersion: 1,
            authoredVersion: 1,
            lifecycle: "published",
            publishedDigest: canonicalHash(spec),
          },
          spec,
        },
        binding: {
          url,
          operation: source.operation,
          document,
          mutating,
          maxResponseBytes: operation.response.maxBytes,
          headers: {},
          ...(operation.rateLimit?.retryAfterHeader === undefined
            ? {}
            : { retryAfterHeader: operation.rateLimit.retryAfterHeader }),
          ...(operation.credentialInjection === undefined
            ? {}
            : {
                auth: {
                  in: "header" as const,
                  credentialSlot: operation.credentialSlot,
                  header: graphqlCredentialHeader(operation),
                  format: operation.credentialInjection.format,
                  ...(operation.credentialInjection.encoding === undefined
                    ? {}
                    : { encoding: operation.credentialInjection.encoding }),
                },
              }),
        },
        ...(operation.response.projection === undefined
          ? {}
          : { projection: operation.response.projection }),
        ...(operation.pagination === undefined ? {} : { pagination: operation.pagination }),
      };
    });
}
