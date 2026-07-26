import type { ExternalIntegrationActivationRegistry } from "./conformance";
import {
  EXTERNAL_INTEGRATION_PROTOCOL_VERSION,
  type ExternalIntegrationAuthentication,
  type ExternalIntegrationIdentity,
  type ExternalIntegrationOperation,
  ExternalIntegrationProtocolError,
  type ExternalIntegrationProtocolTransport,
  type ExternalIntegrationRpcResponse,
  externalIntegrationIdentityKey,
  sameExternalIntegrationIdentity,
} from "./protocol";

export interface ExternalIntegrationAccessPort {
  authorize(input: {
    readonly identity: ExternalIntegrationIdentity;
    readonly accessGrantId: string;
    readonly operation: ExternalIntegrationOperation;
  }): Promise<boolean>;
}

export interface ExternalIntegrationAuditEvent {
  readonly action: "external_integration_rpc";
  readonly decision: "allowed" | "denied";
  readonly identity: ExternalIntegrationIdentity;
  readonly operation: ExternalIntegrationOperation;
  readonly requestId: string;
  readonly reason?: string;
}

export interface ExternalIntegrationAuditPort {
  record(event: ExternalIntegrationAuditEvent): Promise<void>;
}

export interface ExternalIntegrationGatewayDependencies {
  readonly activations: ExternalIntegrationActivationRegistry;
  readonly transport: ExternalIntegrationProtocolTransport;
  readonly access: ExternalIntegrationAccessPort;
  readonly audit: ExternalIntegrationAuditPort;
  readonly issueAuthentication: (input: {
    readonly identity: ExternalIntegrationIdentity;
    readonly operation: ExternalIntegrationOperation;
  }) => Promise<ExternalIntegrationAuthentication>;
  readonly requestId: () => string;
  readonly now: () => Date;
}

export interface ExternalIntegrationInvocation {
  readonly identity: ExternalIntegrationIdentity;
  readonly operation: ExternalIntegrationOperation;
  readonly schemaDigest: string;
  readonly payload: unknown;
}

interface RateWindow {
  startedAt: number;
  requests: number;
}

export class ExternalIntegrationGateway {
  private readonly rates = new Map<string, RateWindow>();

  constructor(private readonly dependencies: ExternalIntegrationGatewayDependencies) {}

  async invoke(invocation: ExternalIntegrationInvocation): Promise<unknown> {
    const requestId = this.dependencies.requestId();
    const descriptor = this.dependencies.activations.require(invocation.identity);
    const capability = descriptor.capabilities.find(
      (candidate) =>
        candidate.operation === invocation.operation &&
        candidate.schemaDigest === invocation.schemaDigest
    );
    if (capability === undefined) {
      await this.denied(invocation, requestId, "schema_mismatch");
      throw new ExternalIntegrationProtocolError("schema_mismatch");
    }
    if (!this.takeRate(invocation.identity, descriptor.rateLimit)) {
      await this.denied(invocation, requestId, "rate_limited");
      throw new ExternalIntegrationProtocolError("rate_limited");
    }
    const allowed = await this.dependencies.access.authorize({
      identity: invocation.identity,
      accessGrantId: descriptor.accessGrantId,
      operation: invocation.operation,
    });
    if (!allowed) {
      await this.denied(invocation, requestId, "access_denied");
      throw new ExternalIntegrationProtocolError("access_denied");
    }

    const authentication = await this.dependencies.issueAuthentication({
      identity: invocation.identity,
      operation: invocation.operation,
    });
    let response: ExternalIntegrationRpcResponse;
    try {
      response = await this.dependencies.transport.invoke({
        requestId,
        protocolVersion: EXTERNAL_INTEGRATION_PROTOCOL_VERSION,
        identity: invocation.identity,
        operation: invocation.operation,
        schemaDigest: capability.schemaDigest,
        payload: invocation.payload,
        authentication,
      });
    } catch {
      await this.denied(invocation, requestId, "unavailable");
      throw new ExternalIntegrationProtocolError("remote_error");
    }

    if (response.requestId !== requestId) {
      await this.denied(invocation, requestId, "request_mismatch");
      throw new ExternalIntegrationProtocolError("request_mismatch");
    }
    if (response.protocolVersion !== EXTERNAL_INTEGRATION_PROTOCOL_VERSION) {
      await this.denied(invocation, requestId, "protocol_mismatch");
      throw new ExternalIntegrationProtocolError("protocol_mismatch");
    }
    if (!sameExternalIntegrationIdentity(response.identity, invocation.identity)) {
      await this.denied(invocation, requestId, "adapter_identity_mismatch");
      throw new ExternalIntegrationProtocolError("adapter_identity_mismatch");
    }
    if (!response.ok) {
      await this.denied(invocation, requestId, response.error.code);
      throw new ExternalIntegrationProtocolError("remote_error");
    }
    await this.dependencies.audit.record({
      action: "external_integration_rpc",
      decision: "allowed",
      identity: invocation.identity,
      operation: invocation.operation,
      requestId,
    });
    return response.result;
  }

  private takeRate(
    identity: ExternalIntegrationIdentity,
    limit: { readonly maximumRequests: number; readonly windowSeconds: number }
  ): boolean {
    const key = externalIntegrationIdentityKey(identity);
    const now = this.dependencies.now().getTime();
    const current = this.rates.get(key);
    if (current === undefined || now - current.startedAt >= limit.windowSeconds * 1000) {
      this.rates.set(key, { startedAt: now, requests: 1 });
      return true;
    }
    if (current.requests >= limit.maximumRequests) return false;
    current.requests += 1;
    return true;
  }

  private async denied(
    invocation: ExternalIntegrationInvocation,
    requestId: string,
    reason: string
  ): Promise<void> {
    await this.dependencies.audit.record({
      action: "external_integration_rpc",
      decision: "denied",
      identity: invocation.identity,
      operation: invocation.operation,
      requestId,
      reason,
    });
  }
}
