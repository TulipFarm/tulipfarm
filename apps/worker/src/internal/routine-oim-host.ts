import { OIM_CONNECTION_ID_ARGUMENT } from "@tulipfarm/integrations";
import type { ToolAdapterKind } from "@tulipfarm/schema";
import {
  AdapterDispatchError,
  type ToolAdapter,
  type ToolAdapterRequest,
} from "@tulipfarm/tool-broker";
import type {
  RoutineOimPreparation,
  RoutineOimPreparationPort,
  RoutineToolRequest,
} from "../routine/tool-port";
import type { InternalApiClient } from "./client";

type RemotePreparation =
  | { readonly kind: "unmanaged" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string }
  | {
      readonly kind: "ready";
      readonly adapter: { readonly kind: ToolAdapterKind; readonly ref: string };
      readonly destination?: string;
      readonly credentialRef?: string;
      readonly connection?: Extract<
        RoutineOimPreparation,
        { readonly kind: "ready" }
      >["connection"];
      readonly secondaryCredentialRef?: string;
      readonly secondaryConnection?: Extract<
        RoutineOimPreparation,
        { readonly kind: "ready" }
      >["secondaryConnection"];
      readonly filePrincipalId?: string;
    };

type RemoteDispatch =
  | { readonly kind: "succeeded"; readonly output: unknown }
  | {
      readonly kind: "failed";
      readonly error: {
        readonly phase: "before_dispatch" | "after_dispatch";
        readonly code: string;
        readonly retryable: boolean;
        readonly providerRequestId?: string;
        readonly retryAfterMs?: number;
      };
    };

function splitArguments(arguments_: Record<string, unknown>): {
  readonly connectionId?: string;
  readonly providerArguments: Record<string, unknown>;
} {
  const { [OIM_CONNECTION_ID_ARGUMENT]: connectionId, ...providerArguments } = arguments_;
  return {
    ...(typeof connectionId === "string" && connectionId.length > 0 ? { connectionId } : {}),
    providerArguments,
  };
}

class HttpRoutineOimAdapter implements ToolAdapter {
  constructor(
    readonly kind: ToolAdapterKind,
    private readonly client: InternalApiClient
  ) {}

  async dispatch(request: ToolAdapterRequest): Promise<unknown> {
    const result = await this.client.require<RemoteDispatch>(
      "POST",
      `/api/v1/internal/runs/${encodeURIComponent(request.intent.runId)}/routine-tools/${encodeURIComponent(request.intent.intentId)}/dispatch`,
      { attempt: request.attempt }
    );
    if (result.kind === "succeeded") return result.output;
    throw new AdapterDispatchError(
      result.error.phase,
      result.error.code,
      result.error.retryable,
      result.error.providerRequestId,
      result.error.retryAfterMs
    );
  }
}

/** API-backed OIM preparation and dispatch. The Worker never receives plaintext Credentials. */
export class HttpRoutineOimHost implements RoutineOimPreparationPort {
  constructor(private readonly client: InternalApiClient) {}

  async prepare(request: RoutineToolRequest): Promise<RoutineOimPreparation> {
    const { connectionId, providerArguments } = splitArguments(request.plan.arguments);
    const resolved = await this.client.require<RemotePreparation>(
      "POST",
      `/api/v1/internal/runs/${encodeURIComponent(request.runId)}/routine-states/${encodeURIComponent(request.stateKey)}/tool/resolve`,
      {
        ...(connectionId === undefined ? {} : { connectionId }),
      }
    );
    if (resolved.kind !== "ready") return resolved;
    return {
      kind: "ready",
      arguments: providerArguments,
      adapterRef: resolved.adapter.ref,
      adapter: new HttpRoutineOimAdapter(resolved.adapter.kind, this.client),
      hostCredentials: true,
      ...(resolved.destination === undefined ? {} : { destination: resolved.destination }),
      ...(resolved.credentialRef === undefined ? {} : { credentialRef: resolved.credentialRef }),
      ...(resolved.connection === undefined ? {} : { connection: resolved.connection }),
      ...(resolved.secondaryCredentialRef === undefined
        ? {}
        : { secondaryCredentialRef: resolved.secondaryCredentialRef }),
      ...(resolved.secondaryConnection === undefined
        ? {}
        : { secondaryConnection: resolved.secondaryConnection }),
      ...(resolved.filePrincipalId === undefined
        ? {}
        : { filePrincipalId: resolved.filePrincipalId }),
    };
  }
}
