import {
  canonicalHash,
  compileJsonSchema,
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
  /** A host-owned parameter whose configuration field this installation has not supplied. */
  | "parameter_configuration_unconfigured"
  /** A host-owned parameter with an undeclared, conflicting, or mistyped configuration field. */
  | "parameter_configuration_invalid"
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

export interface OimCompileOptions {
  readonly deferConfiguration?: boolean;
}

export type OimConfiguration = Readonly<Record<string, string | number | boolean>>;

type HttpParameter = NonNullable<
  Extract<OimOperation["source"], { type: "http" }>["parameters"]
>[number];

function configuredParameterField(parameter: HttpParameter): string | undefined {
  const value = (parameter as HttpParameter & { readonly configurationField?: unknown })
    .configurationField;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function configuredParameterValue(
  manifest: OimManifest,
  operation: OimOperation,
  parameter: HttpParameter,
  configuration: OimConfiguration,
  options: OimCompileOptions
): string | undefined {
  const field = configuredParameterField(parameter);
  if (field === undefined) return undefined;
  if (parameter.value !== undefined) {
    throw new OimHttpCompileError("parameter_configuration_invalid", operation.id);
  }
  const declaration = manifest.auth?.configurationFields?.find(
    (candidate) => candidate.id === field
  );
  const schemaType = (parameter.schema as { readonly type?: unknown }).type;
  const expectedSchemaType =
    declaration?.type === "url" || declaration?.type === "string" ? "string" : declaration?.type;
  if (
    declaration === undefined ||
    expectedSchemaType === undefined ||
    schemaType !== expectedSchemaType
  ) {
    throw new OimHttpCompileError("parameter_configuration_invalid", operation.id);
  }
  const value = configuration[field];
  if (value === undefined) {
    if (options.deferConfiguration !== true) {
      throw new OimHttpCompileError("parameter_configuration_unconfigured", operation.id);
    }
    if (declaration.type === "boolean") return "false";
    if (declaration.type === "integer") return "0";
    return "registration";
  }
  const valid =
    (declaration.type === "boolean" && typeof value === "boolean") ||
    (declaration.type === "integer" && typeof value === "number" && Number.isInteger(value)) ||
    ((declaration.type === "string" || declaration.type === "url") &&
      typeof value === "string" &&
      !value.startsWith("secret://") &&
      !/[\r\n]/.test(value));
  if (!valid) {
    throw new OimHttpCompileError("parameter_configuration_invalid", operation.id);
  }
  if (compileJsonSchema(parameter.schema)(value) !== null) {
    throw new OimHttpCompileError("parameter_configuration_invalid", operation.id);
  }
  return String(value);
}

export const OIM_MUTATING_EFFECTS = new Set<OimOperation["effect"]>([
  "create",
  "update",
  "delete",
  "send",
  "admin",
]);

function operationAction(manifest: OimManifest, operation: OimOperation): string {
  return `integration.${manifest.metadata.id}.${operation.name}`;
}

export function oimRiskClass(effect: OimOperation["effect"]): ToolContractSpec["riskClass"] {
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
    if (parameter.value !== undefined || configuredParameterField(parameter) !== undefined) {
      continue;
    }
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
function configurationValue(configuration: OimConfiguration, field: string): string | undefined {
  const value = configuration[field];
  return value === undefined ? undefined : String(value).trim();
}

function deferredHost(manifest: OimManifest, operation: OimOperation): string {
  const allowed = manifest.auth?.allowedOriginHosts?.[0];
  if (allowed === undefined) {
    throw new OimHttpCompileError("origin_unconfigured", operation.id);
  }
  return allowed.startsWith("*.") ? `registration.${allowed.slice(2)}` : allowed;
}

export function resolveOimUrlTemplate(
  manifest: OimManifest,
  operation: OimOperation,
  template: string,
  configuration: OimConfiguration,
  options: OimCompileOptions = {}
): string {
  const field = oimOriginPlaceholder(template);
  if (field === undefined) return template;

  const supplied =
    configurationValue(configuration, field) ??
    (options.deferConfiguration === true ? deferredHost(manifest, operation) : undefined);
  if (!supplied) throw new OimHttpCompileError("origin_unconfigured", operation.id);

  const host = supplied.includes("://") ? safeHost(supplied, operation.id) : supplied;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)) {
    throw new OimHttpCompileError("destination_invalid", operation.id);
  }
  if (!oimOriginAllowed(host, manifest.auth?.allowedOriginHosts ?? [])) {
    throw new OimHttpCompileError("origin_not_allowed", operation.id);
  }
  return template.replace(`{${field}}`, host);
}

export function resolveOimBaseUrl(
  manifest: OimManifest,
  operation: OimOperation,
  configuration: OimConfiguration,
  options: OimCompileOptions = {}
): string {
  if (operation.source.type !== "http" && operation.source.type !== "openapi") {
    throw new OimHttpCompileError("source_not_http", operation.id);
  }
  const template = operation.source.baseUrl;
  if (template === undefined) {
    throw new OimHttpCompileError("destination_invalid", operation.id);
  }
  return resolveOimUrlTemplate(manifest, operation, template, configuration, options);
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
  values: OimConfiguration,
  options: OimCompileOptions
): string {
  if (operation.source.type !== "http") {
    throw new OimHttpCompileError("source_not_http", operation.id);
  }
  const argumentNames = new Set(
    (operation.source.parameters ?? [])
      .filter(
        (parameter) =>
          parameter.value === undefined && configuredParameterField(parameter) === undefined
      )
      .map((parameter) => parameter.name)
  );
  return template.replace(/\{([^{}]+)\}/g, (match, name: string) => {
    if (name === PATH_CREDENTIAL_PLACEHOLDER || argumentNames.has(name)) return match;
    const supplied =
      configurationValue(values, name) ??
      (options.deferConfiguration === true ? "registration" : undefined);
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

export function oimCredentialBinding(
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
  configuration: OimConfiguration = {},
  options: OimCompileOptions = {}
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
        const configuredValue = configuredParameterValue(
          manifest,
          operation,
          parameter,
          configuration,
          options
        );
        const value = configuredValue ?? parameter.value;
        if (value === undefined) continue;
        if (parameter.in === "header") staticHeaders[parameter.name] = value;
        else if (parameter.in === "query") pinnedQuery[parameter.name] = value;
        else pinnedPath[parameter.name] = value;
      }
      const resolvedBaseUrl = resolveOimBaseUrl(manifest, operation, configuration, options);
      const pathTemplate = resolvePathTemplate(
        operation,
        source.path,
        {
          ...configuration,
          ...pinnedPath,
        },
        options
      );
      const baseUrl = operationDestination(operation, resolvedBaseUrl);
      const toolId = oimToolId(manifest, operation.id);
      const adapterRef = `oim-http:${canonicalHash({ toolId, operation }).slice(0, 32)}`;
      const mutating = OIM_MUTATING_EFFECTS.has(operation.effect);
      const spec: ToolContractSpec = {
        toolId,
        toolVersion: manifest.metadata.version,
        description: operation.description,
        action: operationAction(manifest, operation),
        inputSchema: operationInputSchema(operation),
        outputSchema: paginatedOutputSchema(operation),
        riskClass: oimRiskClass(operation.effect),
        mutating,
        allowedDestinations: [baseUrl.host],
        dataClasses: ["source_content"],
        dryRun: false,
        idempotency: { strategy: mutating ? "reconcile" : "none" },
        retry: { maxAttempts: 3, safeToRetry: true },
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
            .filter(
              (parameter) =>
                parameter.value === undefined && configuredParameterField(parameter) === undefined
            )
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
          ...(operation.rateLimit?.retryAfterHeader === undefined
            ? {}
            : { retryAfterHeader: operation.rateLimit.retryAfterHeader }),
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
        },
        ...(operation.response.mode === "binary" || operation.response.projection === undefined
          ? {}
          : { projection: operation.response.projection }),
        ...(operation.pagination === undefined ? {} : { pagination: operation.pagination }),
      };
    });
}
