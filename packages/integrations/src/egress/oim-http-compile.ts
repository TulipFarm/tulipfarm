import {
  canonicalHash,
  type OimManifest,
  type OimMultipartPart,
  type OimOperation,
  oimOriginAllowed,
  oimOriginPlaceholder,
  oimToolId,
  PATH_CREDENTIAL_PLACEHOLDER,
  type ToolContractDefinition,
  type ToolContractSpec,
} from "@tulipfarm/schema";
import { assertPublicEgressUrl, EgressDestinationError } from "./destination";
import { NEXT_PAGE_TOKEN_PROPERTY, PAGE_TOKEN_ARGUMENT } from "./oim-pagination";
import type { OpenApiOperationBinding } from "./openapi-compile";

export type OimHttpCompileErrorCode =
  | "source_not_http"
  | "destination_invalid"
  | "credential_injection_missing"
  | "pagination_parameter_conflict"
  /** A templated base URL whose configuration field this installation has not supplied. */
  | "origin_unconfigured"
  /** A configured origin outside the hosts the manifest promised. */
  | "origin_not_allowed"
  /** A `{field}` in the path whose configuration value this installation has not supplied. */
  | "path_field_unconfigured";

export class OimHttpCompileError extends Error {
  readonly name = "OimHttpCompileError";

  constructor(
    readonly code: OimHttpCompileErrorCode,
    readonly operationId: string
  ) {
    super(`oim_http_compile:${code}:${operationId}`);
  }
}

export interface CompiledOimHttpTool {
  readonly operation: OimOperation;
  /** Structural parity with `CompiledEgressTool` so one Tool builder serves both compilers. */
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

const MUTATING_EFFECTS = new Set<OimOperation["effect"]>([
  "create",
  "update",
  "delete",
  "send",
  "admin",
]);

function operationAction(manifest: OimManifest, operation: OimOperation): string {
  return `integration.${manifest.metadata.id}.${operation.name}`;
}

function riskClass(effect: OimOperation["effect"]): ToolContractSpec["riskClass"] {
  if (effect === "read") return "low";
  if (effect === "sensitive_read" || effect === "create" || effect === "update") return "medium";
  return "high";
}

function operationInputSchema(operation: OimOperation): Record<string, unknown> {
  if (operation.source.type !== "http") {
    throw new OimHttpCompileError("source_not_http", operation.id);
  }
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const parameter of operation.source.parameters ?? []) {
    // A pinned parameter is not the Agent's to set, so it leaves the contract entirely rather
    // than appearing as an argument the model may fill and the compiler then overwrites.
    if (parameter.value !== undefined) continue;
    properties[parameter.name] = parameter.schema;
    if (parameter.in === "path" || parameter.required === true) required.push(parameter.name);
  }
  if (operation.requestSchema !== undefined) {
    properties.body = operation.requestSchema;
    required.push("body");
  }
  if (operation.pagination !== undefined) {
    // The host owns paging, so the Agent gets one opaque argument instead of the provider's own
    // cursor parameter. A manifest that also declares that parameter would let the Agent set both.
    if (Object.hasOwn(properties, PAGE_TOKEN_ARGUMENT)) {
      throw new OimHttpCompileError("pagination_parameter_conflict", operation.id);
    }
    properties[PAGE_TOKEN_ARGUMENT] = {
      type: "string",
      maxLength: 4096,
      description: "Opaque continuation token from a previous page. Omit for the first page.",
    };
  }
  return {
    type: "object",
    properties,
    additionalProperties: false,
    ...(required.length === 0 ? {} : { required }),
  };
}

/** Widens the declared response schema by the one property the host adds. */
function paginatedOutputSchema(operation: OimOperation): Record<string, unknown> {
  if (operation.response.mode === "binary") {
    return {
      type: "object",
      properties: {
        fileId: { type: "string" },
        summary: {
          type: "object",
          properties: {
            filename: { type: "string" },
            mediaType: { type: "string" },
            sizeBytes: { type: "integer", minimum: 0 },
            truncated: { type: "boolean" },
          },
          required: ["filename", "mediaType", "sizeBytes", "truncated"],
          additionalProperties: false,
        },
      },
      required: ["fileId", "summary"],
      additionalProperties: false,
    };
  }
  const declared = operation.response.schema as Record<string, unknown>;
  if (operation.pagination === undefined) return declared;
  const properties = { ...((declared.properties as Record<string, unknown>) ?? {}) };
  properties[NEXT_PAGE_TOKEN_PROPERTY] = { type: "string" };
  return { ...declared, properties };
}

/**
 * The base URL this installation will actually call.
 *
 * A templated host is resolved here, at compile time, rather than per call: the resolved host is
 * what the Tool contract pins as its allowed destination, so resolving it later would mean a
 * contract that promises one destination and a dispatch that reaches another.
 */
function resolveBaseUrl(
  manifest: OimManifest,
  operation: OimOperation,
  configuration: Readonly<Record<string, string>>
): string {
  if (operation.source.type !== "http") {
    throw new OimHttpCompileError("source_not_http", operation.id);
  }
  const template = operation.source.baseUrl;
  const field = oimOriginPlaceholder(template);
  if (field === undefined) return template;

  const supplied = configuration[field]?.trim();
  if (!supplied) throw new OimHttpCompileError("origin_unconfigured", operation.id);

  // The value may be a bare host or a full origin; both are what an operator pastes from a
  // browser, and rejecting one of them only teaches people to paste the other by trial.
  const host = supplied.includes("://") ? safeHost(supplied, operation.id) : supplied;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)) {
    throw new OimHttpCompileError("destination_invalid", operation.id);
  }
  if (!oimOriginAllowed(host, manifest.auth?.allowedOriginHosts ?? [])) {
    throw new OimHttpCompileError("origin_not_allowed", operation.id);
  }
  return template.replace(`{${field}}`, host);
}

function safeHost(value: string, operationId: string): string {
  try {
    return new URL(value).host;
  } catch {
    throw new OimHttpCompileError("destination_invalid", operationId);
  }
}

/**
 * Fills the path placeholders that are settled before the first call — a pinned parameter value
 * and a non-secret configuration field.
 *
 * Done at compile time, unlike a credential, because neither is a secret and both are constant for
 * the life of the installation: leaving them to dispatch would mean re-deriving per call a value
 * the Tool contract has already promised.
 */
function resolvePathTemplate(
  operation: OimOperation,
  template: string,
  values: Readonly<Record<string, string>>
): string {
  if (operation.source.type !== "http") {
    throw new OimHttpCompileError("source_not_http", operation.id);
  }
  const argumentNames = new Set(
    (operation.source.parameters ?? [])
      .filter((parameter) => parameter.value === undefined)
      .map((parameter) => parameter.name)
  );
  return template.replace(/\{([^{}]+)\}/g, (match, name: string) => {
    if (name === PATH_CREDENTIAL_PLACEHOLDER || argumentNames.has(name)) return match;
    const supplied = values[name]?.trim();
    if (!supplied) throw new OimHttpCompileError("path_field_unconfigured", operation.id);
    return encodeURIComponent(supplied);
  });
}

function operationDestination(operation: OimOperation, baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
    assertPublicEgressUrl(url, baseUrl);
  } catch (error) {
    if (error instanceof EgressDestinationError || error instanceof TypeError) {
      throw new OimHttpCompileError("destination_invalid", operation.id);
    }
    throw error;
  }
  return url;
}

function credentialBinding(
  slot: string,
  injection: NonNullable<OimOperation["credentialInjection"]>
): NonNullable<OpenApiOperationBinding["auth"]> {
  if (injection.in === "path") {
    return {
      in: "path",
      credentialSlot: slot,
      format: injection.format,
      ...(injection.encoding === undefined ? {} : { encoding: injection.encoding }),
    };
  }
  if (injection.in === "header") {
    return {
      in: "header",
      credentialSlot: slot,
      header: injection.name,
      format: injection.format,
      ...(injection.encoding === undefined ? {} : { encoding: injection.encoding }),
    };
  }
  return {
    in: "query",
    credentialSlot: slot,
    name: injection.name,
    format: injection.format,
    ...(injection.encoding === undefined ? {} : { encoding: injection.encoding }),
  };
}

/** Compiles native HTTP operations without inventing credential placement. */
export function compileOimHttpOperations(
  manifest: OimManifest,
  /** Non-secret installation configuration, which fills a templated base URL's host. */
  configuration: Readonly<Record<string, string>> = {}
): CompiledOimHttpTool[] {
  return manifest.operations
    .filter((operation) => operation.source.type === "http")
    .map((operation) => {
      const { source } = operation;
      if (source.type !== "http") {
        throw new OimHttpCompileError("source_not_http", operation.id);
      }
      if (operation.credentialSlot !== undefined && operation.credentialInjection === undefined) {
        throw new OimHttpCompileError("credential_injection_missing", operation.id);
      }
      if (
        operation.secondaryCredential !== undefined &&
        (operation.credentialSlot === undefined || operation.credentialInjection === undefined)
      ) {
        throw new OimHttpCompileError("credential_injection_missing", operation.id);
      }
      const { pagination } = operation;
      if (
        pagination !== undefined &&
        pagination.type !== "link" &&
        pagination.type !== "body_cursor" &&
        (source.parameters ?? []).some(
          (parameter) => parameter.name === pagination.requestParameter
        )
      ) {
        throw new OimHttpCompileError("pagination_parameter_conflict", operation.id);
      }
      const parameters = source.parameters ?? [];
      const staticHeaders: Record<string, string> = {};
      const pinnedQuery: Record<string, string> = {};
      const pinnedPath: Record<string, string> = {};
      for (const parameter of parameters) {
        if (parameter.value === undefined) continue;
        if (parameter.in === "header") staticHeaders[parameter.name] = parameter.value;
        else if (parameter.in === "query") pinnedQuery[parameter.name] = parameter.value;
        else pinnedPath[parameter.name] = parameter.value;
      }
      const resolvedBaseUrl = resolveBaseUrl(manifest, operation, configuration);
      const pathTemplate = resolvePathTemplate(operation, source.path, {
        ...configuration,
        ...pinnedPath,
      });
      const baseUrl = operationDestination(operation, resolvedBaseUrl);
      const toolId = oimToolId(manifest, operation.id);
      const adapterRef = `oim-http:${canonicalHash(toolId).slice(0, 32)}`;
      const mutating = MUTATING_EFFECTS.has(operation.effect);
      const spec: ToolContractSpec = {
        toolId,
        toolVersion: manifest.metadata.version,
        description: operation.description,
        action: operationAction(manifest, operation),
        inputSchema: operationInputSchema(operation),
        outputSchema: paginatedOutputSchema(operation),
        riskClass: riskClass(operation.effect),
        mutating,
        allowedDestinations: [baseUrl.host],
        dataClasses: ["source_content"],
        dryRun: false,
        idempotency: { strategy: mutating ? "reconcile" : "none" },
        retry: { maxAttempts: 1, safeToRetry: false },
        adapter: { kind: "native", ref: adapterRef },
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
            id: `oim-http-${canonicalHash(toolId).slice(0, 26)}`,
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
          method: source.method,
          baseUrl: resolvedBaseUrl.replace(/\/+$/, ""),
          pathTemplate,
          mutating,
          params: parameters
            .filter((parameter) => parameter.value === undefined)
            .map((parameter) => ({ name: parameter.name, in: parameter.in })),
          hasBody: operation.requestSchema !== undefined,
          maxResponseBytes: operation.response.maxBytes,
          headers: staticHeaders,
          ...(Object.keys(pinnedQuery).length === 0 ? {} : { pinnedQuery }),
          ...(source.contentType === undefined ? {} : { contentType: source.contentType }),
          ...(source.multipart === undefined
            ? {}
            : { multipart: source.multipart.parts as readonly OimMultipartPart[] }),
          ...(operation.response.mode === "binary" ? { binaryResponse: true } : {}),
          ...(operation.credentialInjection === undefined || operation.credentialSlot === undefined
            ? {}
            : {
                auth: credentialBinding(operation.credentialSlot, operation.credentialInjection),
              }),
          ...(operation.secondaryCredential === undefined
            ? {}
            : {
                secondaryAuth: credentialBinding(
                  operation.secondaryCredential.slot,
                  operation.secondaryCredential.injection
                ),
              }),
        },
        ...(operation.response.mode === "binary" || operation.response.projection === undefined
          ? {}
          : { projection: operation.response.projection }),
        ...(operation.pagination === undefined ? {} : { pagination: operation.pagination }),
      };
    });
}
