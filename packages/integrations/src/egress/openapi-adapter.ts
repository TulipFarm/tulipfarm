import {
  AdapterDispatchError,
  type ToolAdapter,
  type ToolAdapterRequest,
} from "@tulipfarm/tool-broker";
import {
  classifyHttpFailure,
  type IntegrationHttpMethod,
  type IntegrationHttpResponse,
} from "../http";
import { type OpenApiOperationBinding, PATH_SEGMENT_RE } from "./openapi-compile";

/** Executes exactly one compiled OpenAPI operation selected by its unique adapter ref. */

/** Sends one already-resolved request. Kept separate so tests never touch the network. */
export interface EgressHttpRequest {
  readonly url: string;
  readonly method: IntegrationHttpMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /** Public DNS answers validated by the destination cage and pinned to this connection. */
  readonly pinnedAddresses?: readonly string[];
  /**
   * Hand back undecoded bytes when the response is not text.
   *
   * Off by default because a manifest operation describes a JSON API and every caller of one
   * expects a parsed value. Only a reader that can do something with the bytes — extract a PDF's
   * text, say — should ask, since decoding a binary as UTF-8 destroys it irreversibly and leaves
   * a caller guessing from the replacement characters that survive.
   */
  readonly acceptBinary?: boolean;
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

export class OpenApiToolAdapter implements ToolAdapter {
  readonly kind = "openapi" as const;

  constructor(private readonly deps: OpenApiToolAdapterDeps) {}

  async dispatch(request: ToolAdapterRequest, credential?: string): Promise<unknown> {
    const { binding, http } = this.deps;
    if (binding.auth !== undefined && credential === undefined) {
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

    if (/[{}]/.test(path)) {
      throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
    }

    if (binding.auth?.in === "header" && credential !== undefined) {
      headers[binding.auth.header] = binding.auth.format.replace("{token}", credential);
    }

    const body = binding.hasBody ? args.body : undefined;
    if (body !== undefined) headers["content-type"] = "application/json";

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
    const url = `${base}${path}${search === "" ? "" : `?${search}`}`;

    let response: IntegrationHttpResponse;
    try {
      response = await http.send({
        url,
        method: binding.method,
        headers,
        ...(body === undefined ? {} : { body }),
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

    const failure = classifyHttpFailure(response, binding.mutating);
    if (failure !== null) {
      throw new AdapterDispatchError(failure.phase, failure.code, failure.retryable);
    }
    return response.body;
  }
}
