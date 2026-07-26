export const EXTERNAL_INTEGRATION_PROTOCOL_VERSION = "1.0" as const;

export const EXTERNAL_INTEGRATION_OPERATIONS = [
  "capabilities.get",
  "events.receive",
  "tools.invoke",
  "sync.run",
  "delivery.send",
  "health.get",
] as const;

export type ExternalIntegrationOperation = (typeof EXTERNAL_INTEGRATION_OPERATIONS)[number];

export interface ExternalIntegrationIdentity {
  readonly businessId: string;
  readonly integrationId: string;
  readonly adapterId: string;
}

export interface ExternalIntegrationCapability {
  readonly operation: ExternalIntegrationOperation;
  readonly schemaDigest: string;
}

export interface ExternalIntegrationDescriptor {
  readonly identity: ExternalIntegrationIdentity;
  readonly protocolVersion: typeof EXTERNAL_INTEGRATION_PROTOCOL_VERSION;
  readonly capabilities: readonly ExternalIntegrationCapability[];
  readonly accessGrantId: string;
  readonly rateLimit: {
    readonly maximumRequests: number;
    readonly windowSeconds: number;
  };
  readonly audit: {
    readonly enabled: true;
    readonly payloadLogging: false;
  };
  readonly isolation: {
    readonly mode: "external_process";
    readonly controlPlaneAccess: false;
    readonly crossIntegrationAccess: false;
  };
}

export interface ExternalIntegrationAuthentication {
  readonly token: string;
  readonly expiresAt: string;
}

export interface ExternalIntegrationRpcRequest {
  readonly requestId: string;
  readonly protocolVersion: typeof EXTERNAL_INTEGRATION_PROTOCOL_VERSION;
  readonly identity: ExternalIntegrationIdentity;
  readonly operation: ExternalIntegrationOperation;
  readonly schemaDigest: string;
  readonly payload: unknown;
  readonly authentication?: ExternalIntegrationAuthentication;
}

export type ExternalIntegrationRpcErrorCode =
  | "unauthenticated"
  | "access_denied"
  | "invalid_request"
  | "schema_mismatch"
  | "rate_limited"
  | "unavailable";

interface ExternalIntegrationRpcResponseBase {
  readonly requestId: string;
  readonly protocolVersion: typeof EXTERNAL_INTEGRATION_PROTOCOL_VERSION;
  readonly identity: ExternalIntegrationIdentity;
}

export type ExternalIntegrationRpcResponse =
  | (ExternalIntegrationRpcResponseBase & {
      readonly ok: true;
      readonly result: unknown;
    })
  | (ExternalIntegrationRpcResponseBase & {
      readonly ok: false;
      readonly error: { readonly code: ExternalIntegrationRpcErrorCode };
    });

/**
 * The only control-plane view of third-party code. Implementations live in another process and
 * communicate through authenticated RPC; no callback or module-loading surface is exposed here.
 */
export interface ExternalIntegrationProtocolTransport {
  invoke(request: ExternalIntegrationRpcRequest): Promise<ExternalIntegrationRpcResponse>;
}

export type ExternalIntegrationProtocolErrorCode =
  | "access_denied"
  | "adapter_identity_mismatch"
  | "adapter_not_active"
  | "conformance_failed"
  | "protocol_mismatch"
  | "rate_limited"
  | "remote_error"
  | "request_mismatch"
  | "schema_mismatch";

/** Payload-safe protocol failure. Identity, Credential, and RPC payloads are deliberately absent. */
export class ExternalIntegrationProtocolError extends Error {
  readonly name = "ExternalIntegrationProtocolError";

  constructor(readonly code: ExternalIntegrationProtocolErrorCode) {
    super(`external_integration_protocol:${code}`);
  }
}

export function sameExternalIntegrationIdentity(
  left: ExternalIntegrationIdentity,
  right: ExternalIntegrationIdentity
): boolean {
  return (
    left.businessId === right.businessId &&
    left.integrationId === right.integrationId &&
    left.adapterId === right.adapterId
  );
}

export function externalIntegrationIdentityKey(identity: ExternalIntegrationIdentity): string {
  return `${identity.businessId}\u0000${identity.integrationId}\u0000${identity.adapterId}`;
}
