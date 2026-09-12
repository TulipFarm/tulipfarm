import {
  canonicalHash,
  type OimManifest,
  type OimOperation,
  oimToolId,
  PATH_CREDENTIAL_PLACEHOLDER,
  type ToolContractDefinition,
  type ToolContractSpec,
} from "@tulipfarm/schema";
import {
  OIM_MUTATING_EFFECTS,
  type OimCompileOptions,
  type OimConfiguration,
  oimCredentialBinding,
  oimRiskClass,
  resolveOimBaseUrl,
} from "./oim-http-compile";
import { PAGE_TOKEN_ARGUMENT, withPaginationOutputSchema } from "./oim-pagination";
import type { OpenApiOperationBinding } from "./openapi-compile";
import { compileOpenApiEgress, EgressCompileError } from "./openapi-compile";

export type OimOpenApiCompileErrorCode =
  | "source_not_openapi"
  | "document_missing"
  | "document_invalid"
  | "credential_injection_missing"
  | "operation_not_found";

export class OimOpenApiCompileError extends Error {
  readonly name = "OimOpenApiCompileError";

  constructor(
    readonly code: OimOpenApiCompileErrorCode,
    readonly operationId: string
  ) {
    super(`oim_openapi_compile:${code}:${operationId}`);
  }
}

function hostOwnedParameterNames(operation: OimOperation): Set<string> {
  const names = new Set<string>();
  for (const injection of [
    operation.credentialInjection,
    operation.secondaryCredential?.injection,
  ]) {
    if (injection?.in === "path") names.add(PATH_CREDENTIAL_PLACEHOLDER);
    if (injection?.in === "header" || injection?.in === "query") names.add(injection.name);
  }
  const pagination = operation.pagination;
  if (pagination !== undefined && pagination.type !== "link" && pagination.type !== "body_cursor") {
    names.add(pagination.requestParameter);
  }
  return names;
}

function hostManagedInputSchema(
  operation: OimOperation,
  schema: Record<string, unknown>
): Record<string, unknown> {
  const hidden = hostOwnedParameterNames(operation);
  const declared =
    schema.properties !== null &&
    typeof schema.properties === "object" &&
    !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : {};
  const properties = Object.fromEntries(
    Object.entries(declared).filter(([name]) => !hidden.has(name))
  );
  if (operation.pagination !== undefined) {
    properties[PAGE_TOKEN_ARGUMENT] = {
      type: "string",
      maxLength: 4096,
      description: "Opaque continuation token from a previous page. Omit for the first page.",
    };
  }
  const required = Array.isArray(schema.required)
    ? schema.required.filter(
        (name): name is string => typeof name === "string" && !hidden.has(name)
      )
    : [];
  const { required: _required, ...rest } = schema;
  return {
    ...rest,
    properties,
    ...(required.length === 0 ? {} : { required }),
  };
}

function outputSchema(operation: OimOperation): Record<string, unknown> {
  if (operation.response.mode === "binary") {
    return {
      properties: {
        fileId: { type: "string" },
        summary: { type: "object", additionalProperties: true },
      },
      type: "object",
      required: ["fileId", "summary"],
      additionalProperties: false,
    };
  }
  const declared = operation.response.schema as Record<string, unknown>;
  if (operation.pagination === undefined) return declared;
  return withPaginationOutputSchema(declared);
}

export interface CompiledOimOpenApiTool {
  readonly operation: OimOperation;
  readonly name: string;
  readonly description: string;
  readonly mutating: boolean;
  readonly toolId: string;
  readonly adapterRef: string;
  readonly contract: ToolContractDefinition;
  readonly binding: OpenApiOperationBinding;
  readonly projection?: readonly string[];
  readonly pagination?: NonNullable<OimOperation["pagination"]>;
}

function documentFor(documents: ReadonlyMap<string, unknown>, operation: OimOperation): unknown {
  if (operation.source.type !== "openapi") {
    throw new OimOpenApiCompileError("source_not_openapi", operation.id);
  }
  const document = documents.get(operation.source.file);
  if (document === undefined) {
    throw new OimOpenApiCompileError("document_missing", operation.id);
  }
  return document;
}

function compiledContract(
  manifest: OimManifest,
  operation: OimOperation,
  binding: OpenApiOperationBinding,
  adapterRef: string,
  inputSchema: Record<string, unknown>
): ToolContractDefinition {
  const mutating = OIM_MUTATING_EFFECTS.has(operation.effect);
  const toolId = oimToolId(manifest, operation.id);
  const spec: ToolContractSpec = {
    toolId,
    toolVersion: manifest.metadata.version,
    description: operation.description,
    action: `integration.${manifest.metadata.id}.${operation.name}`,
    inputSchema,
    outputSchema: outputSchema(operation),
    riskClass: oimRiskClass(operation.effect),
    mutating,
    allowedDestinations: [new URL(binding.baseUrl).host],
    dataClasses: ["source_content"],
    dryRun: false,
    idempotency: { strategy: mutating ? "reconcile" : "none" },
    retry: { maxAttempts: 3, safeToRetry: true },
    adapter: { kind: "native", ref: adapterRef },
  };
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "ToolContract",
    metadata: {
      id: `oim-openapi-${canonicalHash(toolId).slice(0, 23)}`,
      slug: `${manifest.metadata.id}-${operation.name}`,
      displayName: operation.name,
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "published",
      publishedDigest: canonicalHash(spec),
    },
    spec,
  };
}

export function compileOimOpenApiOperations(
  manifest: OimManifest,
  documents: ReadonlyMap<string, unknown>,
  configuration: OimConfiguration = {},
  options: OimCompileOptions = {}
): CompiledOimOpenApiTool[] {
  return manifest.operations
    .filter((operation) => operation.source.type === "openapi")
    .map((operation) => {
      if (operation.source.type !== "openapi") {
        throw new OimOpenApiCompileError("source_not_openapi", operation.id);
      }
      if (operation.credentialSlot !== undefined && operation.credentialInjection === undefined) {
        throw new OimOpenApiCompileError("credential_injection_missing", operation.id);
      }
      const document = documentFor(documents, operation);
      const baseUrl =
        operation.source.baseUrl === undefined
          ? undefined
          : resolveOimBaseUrl(manifest, operation, configuration, options);
      let base: ReturnType<typeof compileOpenApiEgress>[number] | undefined;
      try {
        [base] = compileOpenApiEgress({
          slug: manifest.metadata.id,
          egress: {
            type: "openapi",
            spec: operation.source.file,
            operations: [
              {
                operation: operation.source.operationId,
                name: operation.name,
                description: operation.description,
                mutating: OIM_MUTATING_EFFECTS.has(operation.effect),
              },
            ],
            ...(baseUrl === undefined ? {} : { base_url: baseUrl }),
          },
          document,
        });
      } catch (error) {
        if (error instanceof EgressCompileError) {
          throw new OimOpenApiCompileError(
            error.code === "operation_not_found" ? "operation_not_found" : "document_invalid",
            operation.id
          );
        }
        throw error;
      }
      if (base === undefined) {
        throw new OimOpenApiCompileError("operation_not_found", operation.id);
      }

      const binding: OpenApiOperationBinding = {
        ...base.binding,
        mutating: OIM_MUTATING_EFFECTS.has(operation.effect),
        maxResponseBytes: operation.response.maxBytes,
        ...(operation.rateLimit?.retryAfterHeader === undefined
          ? {}
          : { retryAfterHeader: operation.rateLimit.retryAfterHeader }),
        ...(operation.response.mode === "binary" ? { binaryResponse: true } : {}),
        ...(operation.response.mode === "binary"
          ? {}
          : { responseSchema: operation.response.schema }),
        ...(operation.credentialInjection === undefined || operation.credentialSlot === undefined
          ? {}
          : {
              auth: oimCredentialBinding(operation.credentialSlot, operation.credentialInjection),
            }),
        ...(operation.secondaryCredential === undefined
          ? {}
          : {
              secondaryAuth: oimCredentialBinding(
                operation.secondaryCredential.slot,
                operation.secondaryCredential.injection
              ),
            }),
        params: base.binding.params.filter(
          (parameter) => !hostOwnedParameterNames(operation).has(parameter.name)
        ),
      };
      const toolId = oimToolId(manifest, operation.id);
      const adapterRef = `oim-openapi:${canonicalHash({ toolId, operation, document }).slice(0, 32)}`;
      const contract = compiledContract(
        manifest,
        operation,
        binding,
        adapterRef,
        hostManagedInputSchema(operation, base.contract.spec.inputSchema)
      );
      return {
        operation,
        name: operation.name,
        description: operation.description,
        mutating: OIM_MUTATING_EFFECTS.has(operation.effect),
        toolId,
        adapterRef,
        contract,
        binding,
        ...(operation.response.mode === "binary" || operation.response.projection === undefined
          ? {}
          : { projection: operation.response.projection }),
        ...(operation.pagination === undefined ? {} : { pagination: operation.pagination }),
      };
    });
}
