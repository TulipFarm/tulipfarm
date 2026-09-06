import type { OimMultipartPart, OimPagination } from "@tulipfarm/schema";
import {
  AdapterDispatchError,
  type ToolAdapter,
  type ToolAdapterCredentials,
  type ToolAdapterRequest,
} from "@tulipfarm/tool-broker";
import type { OimFilePort } from "./oim-files";
import {
  NEXT_PAGE_TOKEN_PROPERTY,
  nextPageToken,
  OimPaginationError,
  PAGE_TOKEN_ARGUMENT,
  resumeFromToken,
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
  readonly projection?: readonly string[];
  readonly pagination?: OimPagination;
  /** Stable Tool identity a continuation token is bound to. */
  readonly toolId?: string;
  readonly http: EgressHttpPort;
  /** File access stays in the host, where ACL checks and byte validation already live. */
  readonly files?: OimFilePort;
}

const UNSAFE_POINTER_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

function pointerValue(value: unknown, pointer: string): unknown {
  let current = value;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (
      UNSAFE_POINTER_SEGMENTS.has(segment) ||
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !Object.hasOwn(current, segment)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function filePrincipal(request: ToolAdapterRequest): string {
  const principal = request.intent.filePrincipalId;
  if (principal === undefined) {
    throw new AdapterDispatchError("before_dispatch", "file_principal_missing", false);
  }
  return principal;
}

async function multipartParts(
  request: ToolAdapterRequest,
  parts: readonly OimMultipartPart[],
  files: OimFilePort | undefined
): Promise<readonly EgressMultipartPart[]> {
  if (files === undefined) {
    throw new AdapterDispatchError("before_dispatch", "file_port_missing", false);
  }
  const args = request.intent.arguments;
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  }
  const body = (args as Record<string, unknown>).body;
  const principalId = filePrincipal(request);
  const output: EgressMultipartPart[] = [];
  for (const part of parts) {
    const value = pointerValue(body, part.pointer);
    if (value === undefined) {
      throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
    }
    if (part.kind === "field") {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      if (text === undefined || new TextEncoder().encode(text).byteLength > part.maxBytes) {
        throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
      }
      output.push({ name: part.name, body: text });
      continue;
    }
    if (typeof value !== "string") {
      throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
    }
    const content = await files.content({
      businessId: request.intent.businessId,
      fileId: value,
      principalId,
    });
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

  constructor(private readonly deps: OimHttpToolAdapterDeps) {
    this.delegate = new OpenApiToolAdapter({ binding: deps.binding, http: deps.http });
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
            pagination,
            baseUrl: binding.baseUrl,
            ...(typeof suppliedToken === "string" ? { currentToken: suppliedToken } : {}),
          };

    if (context !== undefined && typeof suppliedToken === "string") {
      try {
        const resume = resumeFromToken(context, suppliedToken);
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
    }

    const multipart =
      binding.multipart === undefined
        ? undefined
        : await multipartParts(request, binding.multipart, this.deps.files);
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
    // Redaction precedes projection so a manifest cannot name a credential field as a pointer,
    // and precedes validation so a response schema cannot legitimise one.
    const redacted = redactCredentialFields(raw.body);

    let output: unknown = redacted;
    if (projection !== undefined) {
      if (redacted === null || typeof redacted !== "object") {
        throw new AdapterDispatchError("after_dispatch", "invalid_output", false);
      }
      output = projectResponse(redacted, projection);
    }

    if (context === undefined) return output;
    const token = nextPageToken(context, redacted, raw.headers);
    if (token === undefined) return output;
    if (output === null || typeof output !== "object" || Array.isArray(output)) {
      // A continuation token has nowhere to live on a non-object page, and silently dropping it
      // would strand the caller mid-collection with no way to ask for the rest.
      throw new AdapterDispatchError("after_dispatch", "invalid_output", false);
    }
    return { ...(output as Record<string, unknown>), [NEXT_PAGE_TOKEN_PROPERTY]: token };
  }
}
