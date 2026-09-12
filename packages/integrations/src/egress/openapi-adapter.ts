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

export interface OpenApiDispatchResponse extends IntegrationHttpResponse {
  /** Exact request URL shape with declared URL credentials replaced by internal markers. */
  readonly paginationUrl: string;
  /** Resolves a provider Link and removes credentials only from their declared URL positions. */
  readonly resolvePaginationLink: (candidate: string) => string | undefined;
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
  if (auth.credentialSlot === undefined) return credential;
  return credentials === undefined ? credential : credentials[auth.credentialSlot];
}

type UrlCredentialBinding = Extract<
  OpenApiCredentialBinding,
  { readonly in: "base_url" | "path" | "query" }
>;

interface UrlCredentialSlot {
  readonly auth: UrlCredentialBinding;
  readonly marker: string;
  readonly value: string;
}

function urlCredentialValue(slot: UrlCredentialSlot): string {
  if (slot.auth.in === "base_url") {
    if (!PATH_SEGMENT_RE.test(slot.value)) {
      throw new AdapterDispatchError("before_dispatch", "credential_invalid", false);
    }
    return slot.value;
  }
  const encoded = encodeCredential(slot.value, slot.auth.encoding);
  if (slot.auth.in === "path" && !PATH_SEGMENT_RE.test(encoded)) {
    throw new AdapterDispatchError("before_dispatch", "credential_invalid", false);
  }
  return encoded;
}

/** Builds the wire URL while keeping declared URL credentials out of pagination state. */
function materializePaginationUrl(
  value: string,
  slots: readonly UrlCredentialSlot[],
  resumed: boolean
): Pick<OpenApiDispatchResponse, "paginationUrl" | "resolvePaginationLink"> & {
  readonly url: string;
} {
  let neutral: URL;
  try {
    neutral = new URL(value);
  } catch {
    throw new AdapterDispatchError(
      "before_dispatch",
      resumed ? "invalid_page_token" : "invalid_arguments",
      false
    );
  }

  for (const { auth } of slots) {
    if (auth.in === "query") neutral.searchParams.delete(auth.name);
  }

  const actual = new URL(neutral);
  const neutralSegments = neutral.pathname.split("/");
  const actualSegments = [...neutralSegments];
  const pathPositions: {
    readonly index: number;
    readonly neutral: string;
    readonly actual: string;
  }[] = [];
  for (const slot of slots) {
    if (slot.auth.in === "query") continue;
    const positions = neutralSegments.flatMap((segment, index) =>
      segment.includes(slot.marker) ? [index] : []
    );
    if (
      positions.length !== 1 ||
      neutralSegments[positions[0] as number]?.split(slot.marker).length !== 2
    ) {
      throw new AdapterDispatchError(
        "before_dispatch",
        resumed ? "invalid_page_token" : "credential_invalid",
        false
      );
    }
    const index = positions[0] as number;
    const neutralSegment = neutralSegments[index] as string;
    const actualSegment = neutralSegment.replace(slot.marker, urlCredentialValue(slot));
    actualSegments[index] = actualSegment;
    pathPositions.push({ index, neutral: neutralSegment, actual: actualSegment });
  }
  actual.pathname = actualSegments.join("/");

  for (const slot of slots) {
    if (slot.auth.in !== "query") continue;
    actual.searchParams.set(
      slot.auth.name,
      slot.auth.format.replace("{token}", urlCredentialValue(slot))
    );
  }

  return {
    url: actual.href,
    paginationUrl: neutral.href,
    resolvePaginationLink: (candidate) => {
      let target: URL;
      try {
        target = new URL(candidate, neutral);
      } catch {
        return undefined;
      }
      const targetSegments = target.pathname.split("/");
      for (const position of pathPositions) {
        const segment = targetSegments[position.index];
        if (segment === position.actual) {
          targetSegments[position.index] = position.neutral;
        } else if (segment !== position.neutral) {
          return undefined;
        }
      }
      target.pathname = targetSegments.join("/");
      for (const { auth } of slots) {
        if (auth.in === "query") target.searchParams.delete(auth.name);
      }
      return target.href;
    },
  };
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
  ): Promise<OpenApiDispatchResponse> {
    const { binding, http } = this.deps;
    const authBindings = [binding.auth, binding.secondaryAuth].filter(
      (auth): auth is OpenApiCredentialBinding => auth !== undefined
    );
    if (authBindings.some((auth) => credentialFor(auth, credential, credentials) === undefined)) {
      throw new AdapterDispatchError("before_dispatch", "credential_missing", false);
    }
    const urlCredentialSlots = authBindings.flatMap((auth, index): UrlCredentialSlot[] => {
      if (auth.in === "header") return [];
      const value = credentialFor(auth, credential, credentials);
      if (value === undefined) return [];
      return [{ auth, marker: `__tulipfarm_oim_credential_${index}__`, value }];
    });

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

    for (const slot of urlCredentialSlots) {
      if (slot.auth.in !== "path") continue;
      path = path.replace(
        `{${PATH_CREDENTIAL_PLACEHOLDER}}`,
        slot.auth.format.replace("{token}", slot.marker)
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

    let base = binding.baseUrl;
    for (const slot of urlCredentialSlots) {
      if (slot.auth.in === "base_url") base = base.replace("{token}", slot.marker);
    }
    const search = query.toString();
    const paginationUrl =
      options?.overrideUrl ?? `${base}${path}${search === "" ? "" : `?${search}`}`;
    const urlMetadata = materializePaginationUrl(
      paginationUrl,
      urlCredentialSlots,
      options?.overrideUrl !== undefined
    );

    let response: IntegrationHttpResponse;
    try {
      response = await http.send({
        url: urlMetadata.url,
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
    return {
      ...response,
      paginationUrl: urlMetadata.paginationUrl,
      resolvePaginationLink: urlMetadata.resolvePaginationLink,
    };
  }
}
