import { describe, expect, it, vi } from "vitest";
import {
  EXTERNAL_INTEGRATION_OPERATIONS,
  EXTERNAL_INTEGRATION_PROTOCOL_VERSION,
  ExternalIntegrationActivationRegistry,
  type ExternalIntegrationConformanceReport,
  type ExternalIntegrationDescriptor,
  ExternalIntegrationGateway,
  type ExternalIntegrationIdentity,
  ExternalIntegrationProtocolError,
  type ExternalIntegrationProtocolTransport,
  runExternalIntegrationConformance,
} from "../../src/external-protocol";
import { MaliciousExternalAdapter } from "./fixtures/malicious-external-adapter";

const IDENTITY = {
  businessId: "business-1",
  integrationId: "integration-1",
  adapterId: "adapter-1",
};

function descriptor(maximumRequests = 2): ExternalIntegrationDescriptor {
  return {
    identity: IDENTITY,
    protocolVersion: EXTERNAL_INTEGRATION_PROTOCOL_VERSION,
    capabilities: EXTERNAL_INTEGRATION_OPERATIONS.map((operation) => ({
      operation,
      schemaDigest: `sha256:${operation}`,
    })),
    accessGrantId: "grant-1",
    rateLimit: { maximumRequests, windowSeconds: 60 },
    audit: { enabled: true, payloadLogging: false },
    isolation: {
      mode: "external_process",
      controlPlaneAccess: false,
      crossIntegrationAccess: false,
    },
  };
}

class ConformantAdapter implements ExternalIntegrationProtocolTransport {
  constructor(readonly advertised: ExternalIntegrationDescriptor) {}

  async invoke(request: Parameters<ExternalIntegrationProtocolTransport["invoke"]>[0]) {
    const common = {
      requestId: request.requestId,
      protocolVersion: EXTERNAL_INTEGRATION_PROTOCOL_VERSION,
      identity: request.identity,
    };
    if (request.authentication === undefined) {
      return { ...common, ok: false as const, error: { code: "unauthenticated" as const } };
    }
    return {
      ...common,
      ok: true as const,
      result:
        request.operation === "capabilities.get"
          ? this.advertised
          : request.operation === "health.get"
            ? { status: "healthy" }
            : {},
    };
  }
}

let requestSequence = 0;

function conformance(
  expected: ExternalIntegrationDescriptor,
  transport: ExternalIntegrationProtocolTransport
) {
  return runExternalIntegrationConformance({
    expected,
    transport,
    issueAuthentication: async () => ({
      token: "opaque-authentication",
      expiresAt: "2099-01-01T00:00:00Z",
    }),
    requestId: () => {
      requestSequence += 1;
      return `request-${requestSequence}`;
    },
  });
}

async function activated(
  expected = descriptor(),
  transport: ExternalIntegrationProtocolTransport = new ConformantAdapter(expected)
) {
  const report = await conformance(expected, transport);
  const activations = new ExternalIntegrationActivationRegistry();
  activations.activate(expected, report);
  return activations;
}

describe("external Integration isolation and drift", () => {
  it("rejects a malicious adapter that requests control-plane or cross-Integration access", async () => {
    const expected = descriptor();
    const malicious = new MaliciousExternalAdapter(expected);

    const report = await conformance(expected, malicious);

    expect(report.passed).toBe(false);
    expect(report.checks).toContainEqual({ name: "process_isolation", passed: false });
    expect(() => new ExternalIntegrationActivationRegistry().activate(expected, report)).toThrow(
      new ExternalIntegrationProtocolError("conformance_failed")
    );
    expect(malicious.requests.every((request) => !Object.hasOwn(request, "controlPlane"))).toBe(
      true
    );
  });

  it("does not accept forged conformance evidence", () => {
    const forged: ExternalIntegrationConformanceReport = {
      passed: true,
      identity: IDENTITY,
      descriptorDigest: "sha256:forged",
      checks: [{ name: "forged", passed: true }],
    };

    expect(() =>
      new ExternalIntegrationActivationRegistry().activate(descriptor(), forged)
    ).toThrow(new ExternalIntegrationProtocolError("conformance_failed"));
  });

  it("keeps the active schema pins when drift adds an ability", async () => {
    const expected = descriptor();
    const activations = await activated(expected);
    const drifted = {
      ...expected,
      capabilities: [
        ...expected.capabilities,
        { operation: "tools.invoke" as const, schemaDigest: "sha256:expanded" },
      ],
    };
    const report = await conformance(expected, new ConformantAdapter(drifted));

    expect(report.passed).toBe(false);
    expect(() => activations.activate(drifted, report)).toThrow(
      new ExternalIntegrationProtocolError("conformance_failed")
    );
    expect(activations.require(IDENTITY)).toEqual(expected);
  });

  it("binds genuine conformance evidence to an immutable descriptor snapshot", async () => {
    const expected = descriptor();
    const report = await conformance(expected, new ConformantAdapter(expected));
    const drifted = {
      ...expected,
      capabilities: [
        ...expected.capabilities,
        { operation: "tools.invoke" as const, schemaDigest: "sha256:expanded" },
      ],
    };
    const activations = new ExternalIntegrationActivationRegistry();

    expect(() => activations.activate(drifted, report)).toThrow(
      new ExternalIntegrationProtocolError("conformance_failed")
    );

    activations.activate(expected, report);
    expected.capabilities.push({
      operation: "tools.invoke",
      schemaDigest: "sha256:mutated-after-activation",
    });
    expect(activations.require(IDENTITY).capabilities).not.toContainEqual({
      operation: "tools.invoke",
      schemaDigest: "sha256:mutated-after-activation",
    });
  });

  it("blocks cross-Integration replies and converts adapter crashes to redacted evidence", async () => {
    const expected = descriptor();
    const malicious = new MaliciousExternalAdapter(expected);
    malicious.descriptor = expected;
    malicious.crossIntegrationIdentity = {
      ...IDENTITY,
      integrationId: "integration-2",
    };
    const audit = { record: vi.fn(async () => undefined) };
    const gateway = new ExternalIntegrationGateway({
      activations: await activated(expected),
      transport: malicious,
      access: { authorize: async () => true },
      audit,
      issueAuthentication: async () => ({
        token: "opaque-authentication",
        expiresAt: "2099-01-01T00:00:00Z",
      }),
      requestId: () => "request-cross",
      now: () => new Date("2026-07-26T00:00:00Z"),
    });

    await expect(
      gateway.invoke({
        identity: IDENTITY,
        operation: "tools.invoke",
        schemaDigest: "sha256:tools.invoke",
        payload: { private: "payload-must-not-enter-evidence" },
      })
    ).rejects.toMatchObject({ code: "adapter_identity_mismatch" });

    malicious.crossIntegrationIdentity = undefined;
    malicious.crash = true;
    await expect(
      gateway.invoke({
        identity: IDENTITY,
        operation: "tools.invoke",
        schemaDigest: "sha256:tools.invoke",
        payload: {},
      })
    ).rejects.toEqual(new ExternalIntegrationProtocolError("remote_error"));
    expect(JSON.stringify(audit.record.mock.calls)).not.toMatch(
      /payload-must-not-enter-evidence|opaque-authentication|secret:\/\//
    );
  });

  it("enforces the conformed rate before dispatch", async () => {
    const expected = descriptor(1);
    const transport = new ConformantAdapter(expected);
    const invoke = vi.spyOn(transport, "invoke");
    const gateway = new ExternalIntegrationGateway({
      activations: await activated(expected),
      transport,
      access: { authorize: async () => true },
      audit: { record: async () => undefined },
      issueAuthentication: async () => ({
        token: "opaque-authentication",
        expiresAt: "2099-01-01T00:00:00Z",
      }),
      requestId: () => "request-rate",
      now: () => new Date("2026-07-26T00:00:00Z"),
    });
    const invocation = {
      identity: IDENTITY as ExternalIntegrationIdentity,
      operation: "tools.invoke" as const,
      schemaDigest: "sha256:tools.invoke",
      payload: {},
    };

    await gateway.invoke(invocation);
    await expect(gateway.invoke(invocation)).rejects.toMatchObject({ code: "rate_limited" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
