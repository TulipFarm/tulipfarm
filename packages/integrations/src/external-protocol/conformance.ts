import { canonicalHash } from "@tulipfarm/schema";
import {
  EXTERNAL_INTEGRATION_OPERATIONS,
  EXTERNAL_INTEGRATION_PROTOCOL_VERSION,
  type ExternalIntegrationAuthentication,
  type ExternalIntegrationCapability,
  type ExternalIntegrationDescriptor,
  type ExternalIntegrationIdentity,
  ExternalIntegrationProtocolError,
  type ExternalIntegrationProtocolTransport,
  type ExternalIntegrationRpcRequest,
  type ExternalIntegrationRpcResponse,
  sameExternalIntegrationIdentity,
} from "./protocol";

export interface ExternalIntegrationConformanceCheck {
  readonly name: string;
  readonly passed: boolean;
}

export interface ExternalIntegrationConformanceReport {
  readonly passed: boolean;
  readonly identity: ExternalIntegrationIdentity;
  readonly descriptorDigest: string;
  readonly checks: readonly ExternalIntegrationConformanceCheck[];
}

export interface ExternalIntegrationConformanceRequest {
  readonly expected: ExternalIntegrationDescriptor;
  readonly transport: ExternalIntegrationProtocolTransport;
  readonly issueAuthentication: () => Promise<ExternalIntegrationAuthentication>;
  readonly requestId: () => string;
}

const verifiedReports = new WeakSet<object>();

function descriptorSnapshot(
  descriptor: ExternalIntegrationDescriptor
): ExternalIntegrationDescriptor {
  const identity = Object.freeze({ ...descriptor.identity });
  const capabilities = Object.freeze(
    descriptor.capabilities.map((capability) => Object.freeze({ ...capability }))
  );
  return Object.freeze({
    ...descriptor,
    identity,
    capabilities,
    rateLimit: Object.freeze({ ...descriptor.rateLimit }),
    audit: Object.freeze({ ...descriptor.audit }),
    isolation: Object.freeze({ ...descriptor.isolation }),
  });
}

function request(
  expected: ExternalIntegrationDescriptor,
  requestId: string,
  operation: ExternalIntegrationRpcRequest["operation"],
  authentication?: ExternalIntegrationAuthentication
): ExternalIntegrationRpcRequest {
  const schemaDigest =
    expected.capabilities.find((capability) => capability.operation === operation)?.schemaDigest ??
    "";
  return {
    requestId,
    protocolVersion: EXTERNAL_INTEGRATION_PROTOCOL_VERSION,
    identity: expected.identity,
    operation,
    schemaDigest,
    payload: {},
    ...(authentication === undefined ? {} : { authentication }),
  };
}

async function invokeForConformance(
  transport: ExternalIntegrationProtocolTransport,
  rpcRequest: ExternalIntegrationRpcRequest
): Promise<ExternalIntegrationRpcResponse> {
  try {
    return await transport.invoke(rpcRequest);
  } catch {
    return {
      requestId: rpcRequest.requestId,
      protocolVersion: EXTERNAL_INTEGRATION_PROTOCOL_VERSION,
      identity: rpcRequest.identity,
      ok: false,
      error: { code: "unavailable" },
    };
  }
}

function isDescriptor(value: unknown): value is ExternalIntegrationDescriptor {
  if (typeof value !== "object" || value === null) return false;
  const descriptor = value as Partial<ExternalIntegrationDescriptor>;
  return (
    descriptor.protocolVersion === EXTERNAL_INTEGRATION_PROTOCOL_VERSION &&
    typeof descriptor.accessGrantId === "string" &&
    Array.isArray(descriptor.capabilities) &&
    typeof descriptor.identity === "object" &&
    descriptor.identity !== null &&
    typeof descriptor.rateLimit === "object" &&
    descriptor.rateLimit !== null &&
    typeof descriptor.audit === "object" &&
    descriptor.audit !== null &&
    typeof descriptor.isolation === "object" &&
    descriptor.isolation !== null
  );
}

function capabilityPins(capabilities: readonly ExternalIntegrationCapability[]): string[] {
  return capabilities
    .map((capability) => `${capability.operation}\u0000${capability.schemaDigest}`)
    .sort();
}

function samePins(
  expected: readonly ExternalIntegrationCapability[],
  observed: readonly ExternalIntegrationCapability[]
): boolean {
  const expectedPins = capabilityPins(expected);
  const observedPins = capabilityPins(observed);
  return (
    expectedPins.length === observedPins.length &&
    expectedPins.every((pin, index) => pin === observedPins[index])
  );
}

function hasEveryOperation(capabilities: readonly ExternalIntegrationCapability[]): boolean {
  const operations = new Set(capabilities.map((capability) => capability.operation));
  return EXTERNAL_INTEGRATION_OPERATIONS.every((operation) => operations.has(operation));
}

function healthy(response: ExternalIntegrationRpcResponse): boolean {
  if (!response.ok || typeof response.result !== "object" || response.result === null) return false;
  return (response.result as { status?: unknown }).status === "healthy";
}

function rpcBound(
  response: ExternalIntegrationRpcResponse,
  requestId: string,
  identity: ExternalIntegrationIdentity
): boolean {
  return (
    response.protocolVersion === EXTERNAL_INTEGRATION_PROTOCOL_VERSION &&
    response.requestId === requestId &&
    sameExternalIntegrationIdentity(response.identity, identity)
  );
}

/**
 * Exercise the external boundary before activation. A declaration alone is insufficient: the
 * adapter must reject an unauthenticated RPC, answer an authenticated capability challenge, and
 * report health under the same pinned protocol.
 */
export async function runExternalIntegrationConformance(
  input: ExternalIntegrationConformanceRequest
): Promise<ExternalIntegrationConformanceReport> {
  const unauthenticatedRequestId = input.requestId();
  const unauthenticated = await invokeForConformance(
    input.transport,
    request(input.expected, unauthenticatedRequestId, "capabilities.get")
  );
  const authentication = await input.issueAuthentication();
  const capabilitiesRequestId = input.requestId();
  const capabilities = await invokeForConformance(
    input.transport,
    request(input.expected, capabilitiesRequestId, "capabilities.get", authentication)
  );
  const healthRequestId = input.requestId();
  const health = await invokeForConformance(
    input.transport,
    request(input.expected, healthRequestId, "health.get", authentication)
  );
  const descriptor =
    capabilities.ok && isDescriptor(capabilities.result) ? capabilities.result : undefined;

  const checks: ExternalIntegrationConformanceCheck[] = [
    {
      name: "authentication",
      passed: !unauthenticated.ok && unauthenticated.error.code === "unauthenticated",
    },
    {
      name: "rpc_binding",
      passed:
        rpcBound(unauthenticated, unauthenticatedRequestId, input.expected.identity) &&
        rpcBound(capabilities, capabilitiesRequestId, input.expected.identity) &&
        rpcBound(health, healthRequestId, input.expected.identity),
    },
    {
      name: "protocol_version",
      passed:
        descriptor !== undefined &&
        capabilities.protocolVersion === EXTERNAL_INTEGRATION_PROTOCOL_VERSION &&
        sameExternalIntegrationIdentity(descriptor.identity, input.expected.identity),
    },
    {
      name: "schema_pins",
      passed:
        descriptor !== undefined &&
        hasEveryOperation(descriptor.capabilities) &&
        samePins(input.expected.capabilities, descriptor.capabilities),
    },
    {
      name: "access_grant",
      passed:
        descriptor !== undefined &&
        descriptor.accessGrantId !== "" &&
        descriptor.accessGrantId === input.expected.accessGrantId,
    },
    {
      name: "rate_limit",
      passed:
        descriptor !== undefined &&
        descriptor.rateLimit.maximumRequests === input.expected.rateLimit.maximumRequests &&
        descriptor.rateLimit.windowSeconds === input.expected.rateLimit.windowSeconds &&
        descriptor.rateLimit.maximumRequests > 0 &&
        descriptor.rateLimit.windowSeconds > 0,
    },
    {
      name: "audit_redaction",
      passed:
        descriptor !== undefined &&
        descriptor.audit.enabled === true &&
        descriptor.audit.payloadLogging === false,
    },
    {
      name: "process_isolation",
      passed:
        descriptor !== undefined &&
        descriptor.isolation.mode === "external_process" &&
        descriptor.isolation.controlPlaneAccess === false &&
        descriptor.isolation.crossIntegrationAccess === false,
    },
    { name: "health", passed: healthy(health) },
  ];

  const report = Object.freeze({
    passed: checks.every((check) => check.passed),
    identity: Object.freeze({ ...input.expected.identity }),
    descriptorDigest: canonicalHash(input.expected),
    checks: Object.freeze(checks.map((check) => Object.freeze(check))),
  });
  verifiedReports.add(report);
  return report;
}

export class ExternalIntegrationActivationRegistry {
  private readonly active = new Map<string, ExternalIntegrationDescriptor>();

  activate(
    descriptor: ExternalIntegrationDescriptor,
    report: ExternalIntegrationConformanceReport
  ): void {
    if (
      !verifiedReports.has(report) ||
      !report.passed ||
      !sameExternalIntegrationIdentity(descriptor.identity, report.identity) ||
      canonicalHash(descriptor) !== report.descriptorDigest
    ) {
      throw new ExternalIntegrationProtocolError("conformance_failed");
    }
    const snapshot = descriptorSnapshot(descriptor);
    this.active.set(this.key(snapshot.identity), snapshot);
  }

  revoke(identity: ExternalIntegrationIdentity): void {
    this.active.delete(this.key(identity));
  }

  require(identity: ExternalIntegrationIdentity): ExternalIntegrationDescriptor {
    const descriptor = this.active.get(this.key(identity));
    if (descriptor === undefined) {
      throw new ExternalIntegrationProtocolError("adapter_not_active");
    }
    return descriptor;
  }

  private key(identity: ExternalIntegrationIdentity): string {
    return `${identity.businessId}\u0000${identity.integrationId}\u0000${identity.adapterId}`;
  }
}
