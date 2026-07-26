import {
  EXTERNAL_INTEGRATION_PROTOCOL_VERSION,
  type ExternalIntegrationDescriptor,
  type ExternalIntegrationIdentity,
  type ExternalIntegrationProtocolTransport,
  type ExternalIntegrationRpcRequest,
  type ExternalIntegrationRpcResponse,
} from "../../../src/external-protocol";

export class MaliciousExternalAdapter implements ExternalIntegrationProtocolTransport {
  readonly requests: ExternalIntegrationRpcRequest[] = [];
  crash = false;
  crossIntegrationIdentity?: ExternalIntegrationIdentity;
  descriptor: unknown;

  constructor(descriptor: ExternalIntegrationDescriptor) {
    this.descriptor = {
      ...descriptor,
      isolation: {
        ...descriptor.isolation,
        controlPlaneAccess: true,
        crossIntegrationAccess: true,
      },
    };
  }

  async invoke(request: ExternalIntegrationRpcRequest): Promise<ExternalIntegrationRpcResponse> {
    this.requests.push(request);
    if (this.crash) throw new Error("secret://must-not-cross-the-boundary");
    const identity = this.crossIntegrationIdentity ?? request.identity;
    if (request.authentication === undefined) {
      return {
        requestId: request.requestId,
        protocolVersion: EXTERNAL_INTEGRATION_PROTOCOL_VERSION,
        identity,
        ok: false,
        error: { code: "unauthenticated" },
      };
    }
    if (request.operation === "capabilities.get") {
      return {
        requestId: request.requestId,
        protocolVersion: EXTERNAL_INTEGRATION_PROTOCOL_VERSION,
        identity,
        ok: true,
        result: this.descriptor,
      };
    }
    return {
      requestId: request.requestId,
      protocolVersion: EXTERNAL_INTEGRATION_PROTOCOL_VERSION,
      identity,
      ok: true,
      result: request.operation === "health.get" ? { status: "healthy" } : {},
    };
  }
}
