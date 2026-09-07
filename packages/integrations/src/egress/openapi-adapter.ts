import { PATH_CREDENTIAL_PLACEHOLDER } from "@tulipfarm/schema";
import {
  AdapterDispatchError,
  type ToolAdapter,
  type ToolAdapterCredentials,
  type ToolAdapterRequest,
} from "@tulipfarm/tool-broker";
import {
  classifyHttpFailure,
  type IntegrationHttpMethod,
  type IntegrationHttpResponse,
} from "../http";
import {
  encodeCredential,
  type OpenApiCredentialBinding,
  type OpenApiOperationBinding,
  PATH_SEGMENT_RE,
} from "./openapi-compile";

export interface EgressMultipartPart {
  readonly name: string;
  readonly body: string | AsyncIterable<Uint8Array>;
  readonly filename?: string;
  readonly mediaType?: string;
}

export interface EgressBinaryResponse {
  readonly headers: Readonly<Record<string, string>>;
  readonly declaredBytes: number;
  readonly body: AsyncIterable<Uint8Array>;
}

/**
 * Serialises a flat object as `application/x-www-form-urlencoded`.
 *
 * Flatness is guaranteed at manifest validation, not assumed here: a nested value would have no
 * honest form encoding, and picking one (JSON? bracket notation?) would be the adapter inventing
 * a wire format the provider's documentation never promised.
 */
function formEncode(body: unknown): string {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  }
  const encoded = new URLSearchParams();
  for (const [name, value] of Object.entries(body as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "object") {
      throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
    }
    encoded.set(name, String(value));
  }
  return encoded.toString();
}

/** Writes one string at a single-segment JSON Pointer, returning a copy. */
function withPointer(body: unknown, pointer: string, value: string): unknown {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return body;
  const segments = pointer.replace(/^\//, "").split("/");
  const [head, ...rest] = segments;
  if (head === undefined) return body;
  const key = head.replace(/~1/g, "/").replace(/~0/g, "~");
  const current = (body as Record<string, unknown>)[key];
  return {
    ...(body as Record<string, unknown>),
    [key]: rest.length === 0 ? value : withPointer(current ?? {}, rest.join("/"), value),
  };
}

/** Executes exactly one compiled OpenAPI operation selected by its unique adapter ref. */

/** Sends one already-resolved request. Kept separate so tests never touch the network. */
export interface EgressHttpRequest {
  readonly url: string;
  readonly method: IntegrationHttpMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /**
   * A pre-serialised body, used when the operation is not JSON.
   *
   * Separate from `body` rather than "a string body means send it verbatim": a JSON operation
   * whose request schema is `{"type":"string"}` legitimately expects a quoted body, and collapsing
   * the two would silently strip its quotes. The caller must also set `content-type`.
   */
  readonly bodyText?: string;
  /** Parts whose bodies are streamed directly to the provider. */
  readonly multipart?: readonly EgressMultipartPart[];
  /** Public DNS answers validated by the destination cage and pinned to this connection. */
  readonly pinnedAddresses?: readonly string[];
  /** Per-operation response bound. A transport may impose a stricter deployment-wide ceiling. */
  readonly maxResponseBytes?: number;
  /**
   * Hand back undecoded bytes when the response is not text.
   *
   * Off by default because a manifest operation describes a JSON API and every caller of one
   * expects a parsed value. Only a reader that can do something with the bytes — extract a PDF's
   * text, say — should ask, since decoding a binary as UTF-8 destroys it irreversibly and leaves
   * a caller guessing from the replacement characters that survive.
   */
  readonly acceptBinary?: boolean;
  /** Consumes a successful binary response before it can enter a Tool result. */
  readonly binaryResponse?: (response: EgressBinaryResponse) => Promise<unknown>;
  /**
   * The caller's own deadline, honoured alongside the transport's.
   *
   * Without it the socket answers only to its own clock, so a caller that has already given up —
   * a Tool abandoned at its ceiling — leaves a request in flight that can still land a write.
   */
  readonly signal?: AbortSignal;
}

export interface EgressHttpPort {
  send(request: EgressHttpRequest): Promise<IntegrationHttpResponse>;
}

/** Trusted-host-only request overrides used by host-managed pagination. */
export interface OpenApiDispatchOptions {
  /** Absolute URL replacing the compiled one. The caller must have proved its origin. */
  readonly overrideUrl?: string;
  /** Query parameters added after model arguments, so an Agent cannot shadow them. */
  readonly extraQuery?: Readonly<Record<string, string>>;
  /** A cursor written into the request body, for providers that page by body rather than query. */
  readonly extraBody?: { readonly pointer: string; readonly value: string };
  /** A host-built multipart body. It never comes from model-visible Tool arguments. */
  readonly multipart?: readonly EgressMultipartPart[];
  /** A host-owned binary response sink. */
  readonly binaryResponse?: (response: EgressBinaryResponse) => Promise<unknown>;
}

export interface OpenApiToolAdapterDeps {
  readonly binding: OpenApiOperationBinding;
  readonly http: EgressHttpPort;
}

function argumentsOf(request: ToolAdapterRequest): Record<string, unknown> {
  const raw = request.intent.arguments;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  }
  return raw as Record<string, unknown>;
}

/** Query and header values go on the wire as text; objects are JSON so structure survives. */
function scalar(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function credentialFor(
  auth: OpenApiCredentialBinding,
  credential: string | undefined,
  credentials: ToolAdapterCredentials | undefined
): string | undefined {
  return auth.credentialSlot === undefined
    ? credential
    : (credentials?.[auth.credentialSlot] ?? credential);
}

export class OpenApiToolAdapter implements ToolAdapter {
  readonly kind = "openapi" as const;

  constructor(private readonly deps: OpenApiToolAdapterDeps) {}

  async dispatch(
    request: ToolAdapterRequest,
    credential?: string,
    credentials?: ToolAdapterCredentials
  ): Promise<unknown> {
    return (await this.dispatchDetailed(request, credential, undefined, credentials)).body;
  }

  /**
   * Same request, but with the response envelope kept.
   *
   * Pagination needs the `Link` header, which `dispatch` discards. `options` exists so host-managed
   * pagination can resume a page without a second copy of the request builder; both fields are
   * reachable only from trusted host code that has already validated the target origin.
   */
  async dispatchDetailed(
    request: ToolAdapterRequest,
    credential?: string,
    options?: OpenApiDispatchOptions,
    credentials?: ToolAdapterCredentials
  ): Promise<IntegrationHttpResponse> {
    const { binding, http } = this.deps;
    const authBindings = [binding.auth, binding.secondaryAuth].filter(
      (auth): auth is OpenApiCredentialBinding => auth !== undefined
    );
    if (authBindings.some((auth) => credentialFor(auth, credential, credentials) === undefined)) {
      throw new AdapterDispatchError("before_dispatch", "credential_missing", false);
    }

    const args = argumentsOf(request);
    const headers: Record<string, string> = {
      accept: "application/json",
      ...binding.headers,
    };
    const query = new URLSearchParams();
    let path = binding.pathTemplate;

    for (const param of binding.params) {
      const value = args[param.name];
      if (value === undefined) {
        // A path placeholder with nothing to fill it would otherwise be sent literally, turning a
        // missing argument into a request for a resource named `{page_id}`.
        if (param.in === "path") {
          throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
        }
        continue;
      }
      if (param.in === "path") {
        path = path.replace(`{${param.name}}`, encodeURIComponent(scalar(value)));
      } else if (param.in === "query") {
        query.set(param.name, scalar(value));
      } else {
        headers[param.name] = scalar(value);
      }
    }

    // Before the leftover-placeholder check, since `{credential}` is a placeholder that check
    // would otherwise reject. Never percent-encoded, for the reason given at `base_url` below.
    for (const auth of authBindings) {
      const value = credentialFor(auth, credential, credentials);
      if (auth.in !== "path" || value === undefined) continue;
      const encoded = encodeCredential(value, auth.encoding);
      if (!PATH_SEGMENT_RE.test(encoded)) {
        throw new AdapterDispatchError("before_dispatch", "credential_invalid", false);
      }
      path = path.replace(
        `{${PATH_CREDENTIAL_PLACEHOLDER}}`,
        auth.format.replace("{token}", encoded)
      );
    }

    if (/[{}]/.test(path)) {
      throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
    }

    for (const auth of authBindings) {
      const value = credentialFor(auth, credential, credentials);
      if (value === undefined) continue;
      if (auth.in === "header") {
        headers[auth.header] = auth.format.replace(
          "{token}",
          encodeCredential(value, auth.encoding)
        );
      } else if (auth.in === "query") {
        query.set(
          auth.name,
          auth.format.replace("{token}", encodeCredential(value, auth.encoding))
        );
      }
    }

    for (const [name, value] of Object.entries(binding.pinnedQuery ?? {})) {
      query.set(name, value);
    }

    let body = binding.hasBody ? args.body : undefined;
    if (body !== undefined && options?.extraBody !== undefined) {
      body = withPointer(body, options.extraBody.pointer, options.extraBody.value);
    }
    let bodyText: string | undefined;
    if (options?.multipart !== undefined) {
      body = undefined;
    } else if (body !== undefined) {
      if (binding.contentType === "form") {
        bodyText = formEncode(body);
        body = undefined;
        headers["content-type"] = "application/x-www-form-urlencoded";
      } else {
        headers["content-type"] = "application/json";
      }
    }

    for (const [name, value] of Object.entries(options?.extraQuery ?? {})) {
      // Never let a pagination parameter shadow the credential parameter, whatever a manifest names it.
      if (authBindings.some((auth) => auth.in === "query" && auth.name === name)) continue;
      query.set(name, value);
    }

    const search = query.toString();
    // The credential is part of the address for providers like Telegram. Substituted here rather
    // than at compile time so the compiled binding — which is logged and inspected — never holds
    // the secret; `assertAuthPlacement` proved it is in the path, not the host.
    let base = binding.baseUrl;
    if (binding.auth?.in === "base_url" && credential !== undefined) {
      // Validate rather than percent-encode. Telegram's token contains a literal `:` that its
      // router will not accept as `%3A`, so encoding would send a token the provider rejects and
      // an operator could not recognise. A credential that is not already a clean path segment is
      // not a credential any provider issues for URL placement — refuse it instead of mangling it.
      if (!PATH_SEGMENT_RE.test(credential)) {
        throw new AdapterDispatchError("before_dispatch", "credential_invalid", false);
      }
      base = base.replace("{token}", credential);
    }
    const url = options?.overrideUrl ?? `${base}${path}${search === "" ? "" : `?${search}`}`;

    let response: IntegrationHttpResponse;
    try {
      response = await http.send({
        url,
        method: binding.method,
        headers,
        ...(body === undefined ? {} : { body }),
        ...(bodyText === undefined ? {} : { bodyText }),
        ...(options?.multipart === undefined ? {} : { multipart: options.multipart }),
        ...(options?.binaryResponse === undefined
          ? {}
          : { acceptBinary: true, binaryResponse: options.binaryResponse }),
        ...(binding.maxResponseBytes === undefined
          ? {}
          : { maxResponseBytes: binding.maxResponseBytes }),
      });
    } catch {
      // A transport error on a mutation may or may not have reached the provider. `after_dispatch`
      // makes the effect ambiguous and reconcilable rather than silently retried.
      throw new AdapterDispatchError(
        binding.mutating ? "after_dispatch" : "before_dispatch",
        "transport_error",
        true
      );
    }

    const failure = classifyHttpFailure(
      response,
      binding.mutating,
      binding.retryAfterHeader ?? "Retry-After"
    );
    if (failure !== null) {
      throw new AdapterDispatchError(
        failure.phase,
        failure.code,
        failure.retryable,
        undefined,
        failure.retryAfterMs
      );
    }
    return response;
  }
}
