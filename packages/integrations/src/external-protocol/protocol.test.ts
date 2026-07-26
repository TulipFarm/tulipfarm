import { describe, expect, it, vi } from "vitest";
import {
  EXTERNAL_INTEGRATION_OPERATIONS,
  EXTERNAL_INTEGRATION_PROTOCOL_VERSION,
  ExternalIntegrationActivationRegistry,
  type ExternalIntegrationDescriptor,
  ExternalIntegrationGateway,
  ExternalIntegrationProtocolError,
  type ExternalIntegrationProtocolTransport,
  runExternalIntegrationConformance,
} from "./index";

const IDENTITY = {
  businessId: "business-1",
  integrationId: "integration-1",
  adapterId: "adapter-1",
};

const CAPABILITIES = EXTERNAL_INTEGRATION_OPERATIONS.map((operation) => ({
  operation,
  schemaDigest: `sha256:${operation}`,
}));

const DESCRIPTOR: ExternalIntegrationDescriptor = {
  identity: IDENTITY,
  protocolVersion: EXTERNAL_INTEGRATION_PROTOCOL_VERSION,
  capabilities: CAPABILITIES,
  accessGrantId: "grant-1",
  rateLimit: { maximumRequests: 10, windowSeconds: 60 },
  audit: { enabled: true, payloadLogging: false },
  isolation: {
    mode: "external_process",
    controlPlaneAccess: false,
    crossIntegrationAccess: false,
  },
};

class ConformantTransport implements ExternalIntegrationProtocolTransport {
  async invoke(request: Parameters<ExternalIntegrationProtocolTransport["invoke"]>[0]) {
    if (request.authentication === undefined) {
      return {
        requestId: request.requestId,
        protocolVersion: EXTERNAL_INTEGRATION_PROTOCOL_VERSION,
        identity: IDENTITY,
        ok: false as const,
        error: { code: "unauthenticated" as const },
      };
    }
    if (request.operation === "capabilities.get") {
      return {
        requestId: request.requestId,
        protocolVersion: EXTERNAL_INTEGRATION_PROTOCOL_VERSION,
        identity: IDENTITY,
        ok: true as const,
        result: DESCRIPTOR,
      };
    }
    if (request.operation === "health.get") {
      return {
        requestId: request.requestId,
        protocolVersion: EXTERNAL_INTEGRATION_PROTOCOL_VERSION,
        identity: IDENTITY,
        ok: true as const,
        result: { status: "healthy" },
      };
    }
    return {
      requestId: request.requestId,
      protocolVersion: EXTERNAL_INTEGRATION_PROTOCOL_VERSION,
      identity: IDENTITY,
      ok: true as const,
      result: {},
    };
  }
}

async function conformantReport() {
  let next = 0;
  return runExternalIntegrationConformance({
    expected: DESCRIPTOR,
    transport: new ConformantTransport(),
    issueAuthentication: async () => ({
      token: "opaque-lease",
      expiresAt: "2099-01-01T00:00:00Z",
    }),
    requestId: () => {
      next += 1;
      return `activation-${next}`;
    },
  });
}

describe("external Integration protocol conformance", () => {
  it("requires authenticated versioned RPC and every pinned operation before activation", async () => {
    const report = await runExternalIntegrationConformance({
      expected: DESCRIPTOR,
      transport: new ConformantTransport(),
      issueAuthentication: async () => ({
        token: "opaque-lease",
        expiresAt: "2099-01-01T00:00:00Z",
      }),
      requestId: (() => {
        let next = 0;
        return () => {
          next += 1;
          return `request-${next}`;
        };
      })(),
    });

    expect(report).toEqual({
      passed: true,
      identity: IDENTITY,
      descriptorDigest: expect.any(String),
      checks: expect.arrayContaining([
        { name: "authentication", passed: true },
        { name: "protocol_version", passed: true },
        { name: "schema_pins", passed: true },
        { name: "access_grant", passed: true },
        { name: "rate_limit", passed: true },
        { name: "audit_redaction", passed: true },
        { name: "process_isolation", passed: true },
        { name: "health", passed: true },
      ]),
    });

    const activations = new ExternalIntegrationActivationRegistry();
    activations.activate(DESCRIPTOR, report);
    expect(activations.require(IDENTITY)).toEqual(DESCRIPTOR);
  });

  it("blocks activation when schema drift adds an unpinned ability", async () => {
    const drifted = {
      ...DESCRIPTOR,
      capabilities: [
        ...CAPABILITIES,
        { operation: "tools.invoke" as const, schemaDigest: "sha256:expanded-tool-schema" },
      ],
    };
    const transport = new ConformantTransport();
    vi.spyOn(transport, "invoke").mockImplementation(async (request) => {
      const response = await new ConformantTransport().invoke(request);
      return request.operation === "capabilities.get" && response.ok
        ? { ...response, result: drifted }
        : response;
    });

    const report = await runExternalIntegrationConformance({
      expected: DESCRIPTOR,
      transport,
      issueAuthentication: async () => ({
        token: "opaque-lease",
        expiresAt: "2099-01-01T00:00:00Z",
      }),
      requestId: () => "request-1",
    });

    expect(report.passed).toBe(false);
    expect(report.checks).toContainEqual({ name: "schema_pins", passed: false });
    expect(() => new ExternalIntegrationActivationRegistry().activate(DESCRIPTOR, report)).toThrow(
      new ExternalIntegrationProtocolError("conformance_failed")
    );
  });

  it("binds conformance responses to the challenged Integration identity", async () => {
    const transport = new ConformantTransport();
    vi.spyOn(transport, "invoke").mockImplementation(async (request) => {
      const response = await new ConformantTransport().invoke(request);
      return request.authentication !== undefined
        ? {
            ...response,
            identity: { ...IDENTITY, integrationId: "integration-2" },
          }
        : response;
    });

    const report = await runExternalIntegrationConformance({
      expected: DESCRIPTOR,
      transport,
      issueAuthentication: async () => ({
        token: "opaque-lease",
        expiresAt: "2099-01-01T00:00:00Z",
      }),
      requestId: () => "request-binding",
    });

    expect(report.passed).toBe(false);
    expect(report.checks).toContainEqual({ name: "rpc_binding", passed: false });
  });

  it("turns an adapter crash into redacted failed conformance evidence", async () => {
    const report = await runExternalIntegrationConformance({
      expected: DESCRIPTOR,
      transport: {
        invoke: async () => {
          throw new Error("secret://must-not-cross-conformance");
        },
      },
      issueAuthentication: async () => ({
        token: "opaque-lease",
        expiresAt: "2099-01-01T00:00:00Z",
      }),
      requestId: () => "request-crash",
    });

    expect(report.passed).toBe(false);
    expect(JSON.stringify(report)).not.toMatch(/secret:\/\/|opaque-lease/);
  });
});

describe("external Integration worker gateway", () => {
  it("checks activation, AccessGrant, schema pin, rate, authentication, and safe audit evidence", async () => {
    const transport = new ConformantTransport();
    const audit = { record: vi.fn(async () => undefined) };
    const access = { authorize: vi.fn(async () => true) };
    const activations = new ExternalIntegrationActivationRegistry();
    activations.activate(DESCRIPTOR, await conformantReport());
    const gateway = new ExternalIntegrationGateway({
      activations,
      transport,
      access,
      audit,
      issueAuthentication: async () => ({
        token: "opaque-lease",
        expiresAt: "2099-01-01T00:00:00Z",
      }),
      requestId: () => "request-1",
      now: () => new Date("2026-07-26T00:00:00Z"),
    });

    await expect(
      gateway.invoke({
        identity: IDENTITY,
        operation: "tools.invoke",
        schemaDigest: "sha256:tools.invoke",
        payload: { protected: "must-not-enter-audit" },
      })
    ).resolves.toEqual({});

    expect(access.authorize).toHaveBeenCalledWith({
      identity: IDENTITY,
      accessGrantId: "grant-1",
      operation: "tools.invoke",
    });
    expect(audit.record).toHaveBeenCalledWith({
      action: "external_integration_rpc",
      decision: "allowed",
      identity: IDENTITY,
      operation: "tools.invoke",
      requestId: "request-1",
    });
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain("must-not-enter-audit");
  });

  it("fails closed before transport on authorization, schema, or activation denial", async () => {
    const transport = new ConformantTransport();
    const invoke = vi.spyOn(transport, "invoke");
    const activations = new ExternalIntegrationActivationRegistry();
    activations.activate(DESCRIPTOR, await conformantReport());
    const gateway = new ExternalIntegrationGateway({
      activations,
      transport,
      access: { authorize: async () => false },
      audit: { record: async () => undefined },
      issueAuthentication: async () => ({
        token: "opaque-lease",
        expiresAt: "2099-01-01T00:00:00Z",
      }),
      requestId: () => "request-1",
      now: () => new Date("2026-07-26T00:00:00Z"),
    });

    await expect(
      gateway.invoke({
        identity: IDENTITY,
        operation: "tools.invoke",
        schemaDigest: "sha256:tools.invoke",
        payload: {},
      })
    ).rejects.toMatchObject({ code: "access_denied" });
    expect(invoke).not.toHaveBeenCalled();
  });
});
