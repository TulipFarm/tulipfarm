import {
  ajv,
  canonicalHash,
  type OimManifest,
  type OimMultipartPart,
  type OimPagination,
} from "@tulipfarm/schema";
import {
  AdapterDispatchError,
  type ToolAdapter,
  type ToolAdapterCredentials,
  type ToolAdapterRequest,
} from "@tulipfarm/tool-broker";
import { type OimHookPhaseRunner, runOimHookPhase } from "../oim-hooks";
import {
  extractOimMultipartFileIds,
  type OimFilePort,
  type OimFileReadAuthorizationPort,
  OimMultipartFileInputError,
  oimMultipartPointerValue,
} from "./oim-files";
import {
  DEFAULT_OIM_PAGINATION_BOUNDS,
  NEXT_PAGE_TOKEN_PROPERTY,
  nextPageToken,
  OimPaginationError,
  type OimPaginationRuntime,
  PAGE_TOKEN_ARGUMENT,
  PAGINATED_ITEMS_PROPERTY,
  prepareOimPagination,
} from "./oim-pagination";
import { projectResponse, redactCredentialFields } from "./oim-response";
import type { EgressMultipartPart } from "./openapi-adapter";
import {
  type EgressHttpPort,
  type OpenApiDispatchOptions,
  OpenApiToolAdapter,
} from "./openapi-adapter";
import type { OpenApiOperationBinding } from "./openapi-compile";

export interface OimHttpToolAdapterDeps {
  readonly binding: OpenApiOperationBinding;
  readonly manifest?: Pick<OimManifest, "hooks">;
  readonly hookRunner?: OimHookPhaseRunner;
  readonly projection?: readonly string[];
  readonly pagination?: OimPagination;
  readonly paginationRuntime?: OimPaginationRuntime;
  /** Stable Tool identity a continuation token is bound to. */
  readonly toolId?: string;
  readonly http: EgressHttpPort;
  /** File access stays in the host, where ACL checks and byte validation already live. */
  readonly files?: OimFilePort;
  /** Host policy authorization, separate from the effective user's File ACL check. */
  readonly fileReadAuthorization?: OimFileReadAuthorizationPort;
}

function filePrincipal(request: ToolAdapterRequest): string {
  const principal = request.intent.filePrincipalId;
  if (principal === undefined) {
    throw new AdapterDispatchError("before_dispatch", "file_principal_missing", false);
  }
  return principal;
}

async function multipartParts(
  argumentsValue: unknown,
  businessId: string,
  principalId: string,
  parts: readonly OimMultipartPart[],
  files: OimFilePort | undefined
): Promise<readonly EgressMultipartPart[]> {
  if (
    argumentsValue === null ||
    typeof argumentsValue !== "object" ||
    Array.isArray(argumentsValue)
  ) {
    throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  }
  const body = (argumentsValue as Record<string, unknown>).body;
  const prepared: (
    | { readonly name: string; readonly kind: "field"; readonly body: string }
    | { readonly name: string; readonly kind: "file"; readonly fileId: string }
  )[] = [];
  for (const part of parts) {
    const value = oimMultipartPointerValue(body, part.pointer);
    if (value === undefined) {
      throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
    }
    if (part.kind === "field") {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      if (text === undefined || new TextEncoder().encode(text).byteLength > part.maxBytes) {
        throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
      }
      prepared.push({ name: part.name, kind: "field", body: text });
      continue;
    }
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 128 ||
      value.trim() !== value
    ) {
      throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
    }
    prepared.push({ name: part.name, kind: "file", fileId: value });
  }

  const output: EgressMultipartPart[] = [];
  for (const part of prepared) {
    if (part.kind === "field") {
      output.push({ name: part.name, body: part.body });
      continue;
    }
    if (files === undefined) {
      throw new AdapterDispatchError("before_dispatch", "file_port_missing", false);
    }
    let content: Awaited<ReturnType<OimFilePort["content"]>>;
    try {
      content = await files.content({
        businessId,
        fileId: part.fileId,
        principalId,
      });
    } catch {
      throw new AdapterDispatchError("before_dispatch", "file_access_denied", false);
    }
    if (content.file.id !== part.fileId) {
      throw new AdapterDispatchError("before_dispatch", "file_id_mismatch", false);
    }
    output.push({
      name: part.name,
      filename: content.file.filename,
      mediaType: content.file.mediaType,
      body: content.body,
    });
  }
  return output;
}

function binaryFilename(headers: Readonly<Record<string, string>>, fallback: string): string {
  const disposition = headers["content-disposition"] ?? headers["Content-Disposition"];
  const name = disposition?.match(/filename="?([^";\r\n]+)"?/i)?.[1];
  return name === undefined || name.length === 0 ? fallback : name;
}

/** Native OIM HTTP adapter: bounded transport, credential redaction, projection, opaque paging. */
export class OimHttpToolAdapter implements ToolAdapter {
  readonly kind = "native" as const;
  private readonly delegate: OpenApiToolAdapter;
  private readonly validateResponse?: (value: unknown) => boolean;

  constructor(private readonly deps: OimHttpToolAdapterDeps) {
    this.delegate = new OpenApiToolAdapter({ binding: deps.binding, http: deps.http });
    if (deps.binding.responseSchema !== undefined) {
      const { $id: _id, ...schema } = structuredClone(deps.binding.responseSchema);
      this.validateResponse = ajv.compile(schema);
    }
  }

  async dispatch(
    request: ToolAdapterRequest,
    credential?: string,
    credentials?: ToolAdapterCredentials
  ): Promise<unknown> {
    const { pagination, binding, projection } = this.deps;
    const toolId = this.deps.toolId ?? request.intent.toolId;
    const args = (request.intent.arguments ?? {}) as Record<string, unknown>;
    const suppliedToken = args[PAGE_TOKEN_ARGUMENT];

    let options: OpenApiDispatchOptions | undefined;
    const context =
      pagination === undefined
        ? undefined
        : {
            toolId,
            scope: canonicalHash({
              toolId,
              binding,
              pagination,
              paginationBounds: DEFAULT_OIM_PAGINATION_BOUNDS,
              projection: projection ?? null,
              businessId: request.intent.businessId,
              filePrincipalId: request.intent.filePrincipalId ?? null,
              credentialRef: request.intent.credentialRef ?? null,
            }),
            pagination,
            baseUrl: binding.baseUrl,
          };

    if (context !== undefined && suppliedToken !== undefined && typeof suppliedToken !== "string") {
      throw new AdapterDispatchError("before_dispatch", "invalid_page_token", false);
    }
    const paginationSession =
      context === undefined
        ? undefined
        : await (async () => {
            const runtime = this.deps.paginationRuntime;
            if (runtime === undefined) {
              throw new AdapterDispatchError(
                "before_dispatch",
                "pagination_runtime_missing",
                false
              );
            }
            try {
              return await prepareOimPagination(
                context,
                typeof suppliedToken === "string" ? suppliedToken : undefined,
                runtime
              );
            } catch (error) {
              if (error instanceof OimPaginationError) {
                throw new AdapterDispatchError("before_dispatch", error.code, false);
              }
              throw error;
            }
          })();
    if (paginationSession?.resume !== undefined) {
      try {
        const resume = paginationSession.resume;
        options =
          "url" in resume
            ? { overrideUrl: resume.url }
            : "bodyPointer" in resume
              ? { extraBody: { pointer: resume.bodyPointer, value: resume.value } }
              : { extraQuery: { [resume.parameter]: resume.value } };
      } catch (error) {
        if (error instanceof OimPaginationError) {
          throw new AdapterDispatchError("before_dispatch", error.code, false);
        }
        throw error;
      }
    } else if (pagination?.type === "page") {
      options = {
        extraQuery: {
          [pagination.requestParameter]: String(pagination.start ?? 1),
        },
      };
    }

    const multipartBinding = binding.multipart;
    const multipart =
      multipartBinding === undefined
        ? undefined
        : await (async () => {
            let argumentsSnapshot: unknown;
            let fileIds: readonly string[];
            try {
              argumentsSnapshot = structuredClone(request.intent.arguments);
            } catch {
              throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
            }
            try {
              fileIds = extractOimMultipartFileIds(binding, argumentsSnapshot);
            } catch (error) {
              if (!(error instanceof OimMultipartFileInputError)) throw error;
              throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
            }

            const principalId = fileIds.length === 0 ? "" : filePrincipal(request);
            if (fileIds.length > 0) {
              const authorizer = this.deps.fileReadAuthorization;
              if (authorizer === undefined) {
                throw new AdapterDispatchError(
                  "before_dispatch",
                  "file_authorization_missing",
                  false
                );
              }
              try {
                await authorizer.assertAuthorized({ request, fileIds });
              } catch {
                throw new AdapterDispatchError(
                  "before_dispatch",
                  "file_authorization_denied",
                  false
                );
              }
            }
            return multipartParts(
              argumentsSnapshot,
              request.intent.businessId,
              principalId,
              multipartBinding,
              this.deps.files
            );
          })();
    if (multipart !== undefined) {
      options = { ...options, multipart };
    }
    if (binding.binaryResponse === true) {
      const files = this.deps.files;
      if (files === undefined) {
        throw new AdapterDispatchError("before_dispatch", "file_port_missing", false);
      }
      const principalId = filePrincipal(request);
      options = {
        ...options,
        binaryResponse: async ({ body, declaredBytes, headers }) => {
          const file = await files.store({
            businessId: request.intent.businessId,
            ownerPrincipalId: principalId,
            filename: binaryFilename(headers, `${request.intent.toolId}.file`),
            claimedMediaType: (headers["content-type"] ?? headers["Content-Type"] ?? "").split(
              ";",
              1
            )[0] as string,
            declaredBytes,
            body,
          });
          return {
            fileId: file.id,
            summary: {
              filename: file.filename,
              mediaType: file.mediaType,
              sizeBytes: file.sizeBytes,
              truncated:
                binding.maxResponseBytes !== undefined && file.sizeBytes > binding.maxResponseBytes,
            },
          };
        },
      };
    }

    const raw = await this.delegate.dispatchDetailed(request, credential, options, credentials);
    if (binding.binaryResponse === true) return raw.body;
    if (this.validateResponse !== undefined && !this.validateResponse(raw.body)) {
      throw new AdapterDispatchError("after_dispatch", "invalid_output", false);
    }
    // Redaction precedes projection so a manifest cannot name a credential field as a pointer,
    // and precedes validation so a response schema cannot legitimise one.
    const redacted = redactCredentialFields(raw.body);
    let normalized: unknown = redacted;
    if (this.deps.manifest !== undefined) {
      try {
        const hookResult = await runOimHookPhase({
          manifest: this.deps.manifest,
          kind: "response_normalize",
          input: { payload: redacted, safeHeaders: {} },
          ...(this.deps.hookRunner === undefined ? {} : { runner: this.deps.hookRunner }),
        });
        if (hookResult.executed) normalized = hookResult.value;
      } catch {
        throw new AdapterDispatchError("after_dispatch", "response_normalize_hook_failed", false);
      }
    }

    let output: unknown = normalized;
    if (projection !== undefined) {
      if (normalized === null || typeof normalized !== "object") {
        throw new AdapterDispatchError("after_dispatch", "invalid_output", false);
      }
      output = projectResponse(normalized, projection);
    }

    if (context === undefined) return output;
    if (paginationSession === undefined || this.deps.paginationRuntime === undefined) {
      throw new AdapterDispatchError("after_dispatch", "pagination_runtime_missing", false);
    }
    let token: string | undefined;
    try {
      token = await nextPageToken(
        context,
        paginationSession,
        raw.body,
        raw.headers,
        this.deps.paginationRuntime,
        raw.paginationUrl,
        raw.resolvePaginationLink
      );
    } catch (error) {
      if (error instanceof OimPaginationError) {
        throw new AdapterDispatchError("after_dispatch", error.code, false);
      }
      throw error;
    }
    const pageOutput = Array.isArray(output) ? { [PAGINATED_ITEMS_PROPERTY]: output } : output;
    if (token === undefined) return pageOutput;
    if (pageOutput === null || typeof pageOutput !== "object") {
      // A continuation token has nowhere to live on a non-object page, and silently dropping it
      // would strand the caller mid-collection with no way to ask for the rest.
      throw new AdapterDispatchError("after_dispatch", "invalid_output", false);
    }
    return { ...(pageOutput as Record<string, unknown>), [NEXT_PAGE_TOKEN_PROPERTY]: token };
  }
}
