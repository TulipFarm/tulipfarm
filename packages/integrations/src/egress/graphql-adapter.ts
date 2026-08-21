import {
  AdapterDispatchError,
  type ToolAdapter,
  type ToolAdapterRequest,
} from "@tulipfarm/tool-broker";
import { classifyHttpFailure, type IntegrationHttpResponse } from "../http";
import type { GraphqlOperationBinding } from "./graphql-compile";
import type { EgressHttpPort } from "./openapi-adapter";

export interface GraphqlToolAdapterDeps {
  readonly binding: GraphqlOperationBinding;
  readonly http: EgressHttpPort;
}

function variablesOf(request: ToolAdapterRequest): Record<string, unknown> {
  const value = request.intent.arguments;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  }
  return value as Record<string, unknown>;
}

function hasErrors(body: unknown): boolean {
  return (
    body !== null &&
    typeof body === "object" &&
    "errors" in body &&
    Array.isArray((body as { errors?: unknown }).errors) &&
    (body as { errors: unknown[] }).errors.length > 0
  );
}

/** Sends one manifest-fixed GraphQL operation. Agent arguments are variables, never query text. */
export class GraphqlToolAdapter implements ToolAdapter {
  readonly kind = "graphql" as const;

  constructor(private readonly deps: GraphqlToolAdapterDeps) {}

  async dispatch(request: ToolAdapterRequest, credential?: string): Promise<unknown> {
    const { binding, http } = this.deps;
    if (binding.auth !== undefined && credential === undefined) {
      throw new AdapterDispatchError("before_dispatch", "credential_missing", false);
    }

    const headers: Record<string, string> = { accept: "application/json", ...binding.headers };
    if (binding.auth !== undefined && credential !== undefined) {
      headers[binding.auth.header] = binding.auth.format.replace("{token}", credential);
    }

    let response: IntegrationHttpResponse;
    try {
      response = await http.send({
        url: binding.url,
        method: "POST",
        headers,
        body: {
          operationName: binding.operation,
          query: binding.document,
          variables: variablesOf(request),
        },
      });
    } catch {
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
    if (hasErrors(response.body)) {
      throw new AdapterDispatchError("before_dispatch", "provider_rejected", false);
    }
    return response.body;
  }
}
