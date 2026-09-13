import {
  type OimUninstallGeneration,
  uninstallOimReleaseGeneration,
} from "@tulipfarm/integrations";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OimReleaseControlPlane } from "./control-plane";
import { registerOimReleaseRoutes } from "./routes";

const DIGEST = "a".repeat(64);
const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";

describe("OIM release routes", () => {
  let app: FastifyInstance;
  const install = vi.fn(async () => ({
    installationId: INSTALLATION_ID,
    integrationId: "weather",
    version: "1.2.3",
    majorVersion: 1,
    packageDigest: DIGEST,
    trustClass: "official",
    revision: "soul-a",
  }));
  const uninstall = vi.fn(async (_request: OimUninstallGeneration) => ({
    status: "complete",
    scope: {
      businessId: "business-1",
      integrationId: "weather",
      majorVersion: 2,
      installationId: INSTALLATION_ID,
      packageDigest: DIGEST,
      slug: "weather-v2",
      soulRevision: "soul-a",
    },
  }));
  const uninstallStatus = vi.fn(async (scope: OimUninstallGeneration) => ({
    scope,
    status: "pending" as const,
    activationAllowed: false,
    retryRequired: false,
  }));
  const recover = vi.fn(async () => ({ installationId: INSTALLATION_ID }));
  const setAutoPatchPreference = vi.fn(async () => ({ autoPatchOptIn: false }));
  const acceptRevocationList = vi.fn(async () => ({
    sequence: 2,
    expiresAt: "2026-09-14T09:00:00.000Z",
  }));

  beforeEach(async () => {
    app = Fastify();
    const authenticate = async (request: FastifyRequest) => {
      request.principal = {
        kind: "user",
        id: "operator-1",
        businessId: "business-1",
        credential: "session",
        authMethods: ["password"],
        authenticatedAt: new Date(),
      };
    };
    const control = new OimReleaseControlPlane({
      inspect: async () => ({ source: "safe", ref: "ref-1", candidates: [] }),
      install,
      uninstall,
      uninstallStatus,
      recover,
      getAutoPatchPreference: async () => ({ autoPatchOptIn: true }),
      setAutoPatchPreference,
      listTrustRoots: async () => [],
      addTrustRoot: async () => ({}),
      disableTrustRoot: async () => ({}),
      getRevocationFeed: async () => null,
      setRevocationFeed: async () => ({}),
      disableRevocationFeed: async () => ({}),
      acceptRevocationList,
      runMaintenance: async () => ({ revocations: "updated", patches: [] }),
    });
    registerOimReleaseRoutes(
      app,
      control,
      {
        read: authenticate,
        install: authenticate,
        uninstall: authenticate,
        trust: authenticate,
        maintenance: authenticate,
      },
      "business-1"
    );
    await app.ready();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await app.close();
  });

  it("forwards the exact selected release without client-controlled signature evidence", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/oim/releases/install",
      payload: {
        source: "https://example.test/releases.git",
        slug: "weather-v1",
        selection: {
          integrationId: "weather",
          version: "1.2.3",
          packageDigest: DIGEST,
        },
        trustClass: "official",
        autoPatchOptIn: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ installationId: INSTALLATION_ID });
    expect(install).toHaveBeenCalledWith({
      businessId: "business-1",
      actorId: "user:operator-1",
      source: "https://example.test/releases.git",
      slug: "weather-v1",
      selection: {
        integrationId: "weather",
        version: "1.2.3",
        packageDigest: DIGEST,
      },
      trustClass: "official",
      autoPatchOptIn: true,
    });
  });

  it("does not forward client-controlled release signature evidence", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/oim/releases/install",
      payload: {
        source: "https://example.test/releases.git",
        slug: "weather-v1",
        selection: {
          integrationId: "weather",
          version: "1.2.3",
          packageDigest: DIGEST,
        },
        trustClass: "official",
        signedRelease: { envelopeVersion: 1 },
        autoPatchOptIn: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(install).toHaveBeenCalledWith(
      expect.not.objectContaining({ signedRelease: expect.anything() })
    );
  });

  it("keeps uninstall scoped to the exact installation generation", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/integrations/oim/weather/majors/2/installations/${INSTALLATION_ID}`,
    });

    expect(response.statusCode).toBe(200);
    expect(uninstall).toHaveBeenCalledWith({
      businessId: "business-1",
      actorId: "user:operator-1",
      integrationId: "weather",
      majorVersion: 2,
      installationId: INSTALLATION_ID,
    });
  });

  it("replays completed uninstall A after generation B is installed", async () => {
    const resolveInstalledRelease = vi.fn(async () => ({
      businessId: "business-1",
      integrationId: "weather",
      majorVersion: 2,
      installationId: "22222222-2222-4222-8222-222222222222",
      version: "2.1.0",
      packageDigest: "b".repeat(64),
      slug: "weather-v2",
      soulRevision: "soul-b",
      trustClass: "official" as const,
      originalRequirements: {},
      autoPatchOptIn: false,
      source: "https://example.test/weather.git",
      sourceRef: "commit-b",
      candidatePath: "packages/weather",
      createdAt: "2026-09-13T09:00:00.000Z",
      updatedAt: "2026-09-13T09:00:00.000Z",
    }));
    uninstall.mockImplementationOnce((request) =>
      uninstallOimReleaseGeneration(
        {
          findTarget: resolveInstalledRelease,
          journal: {
            async runExclusive(_scope, operation) {
              return operation();
            },
            async begin() {
              throw new Error("completed generation must not restart");
            },
            async get() {
              return {
                businessId: "business-1",
                integrationId: "weather",
                majorVersion: 2,
                installationId: INSTALLATION_ID,
                version: "2.0.0",
                packageDigest: DIGEST,
                slug: "weather-v2",
                soulRevision: "soul-a",
                status: "complete" as const,
                completedSteps: [],
                revokedConnectionIds: [],
                inFlightWorkIds: [],
                retry: null,
                startedAt: "2026-09-12T09:00:00.000Z",
                updatedAt: "2026-09-12T09:01:00.000Z",
                completedAt: "2026-09-12T09:01:00.000Z",
              };
            },
            async markStepCompleted() {
              throw new Error("completed generation must not advance");
            },
            async markConnectionRevoked() {
              throw new Error("completed generation must not advance");
            },
            async markRetryRequired() {
              throw new Error("completed generation must not fail");
            },
            async markCompleted() {
              throw new Error("completed generation must not advance");
            },
          },
          host: {
            async fenceAndDrain() {
              throw new Error("completed generation must not advance");
            },
            async unsubscribeRemote() {
              throw new Error("completed generation must not advance");
            },
            async listConnections() {
              throw new Error("completed generation must not advance");
            },
            async revokeConnection() {
              throw new Error("completed generation must not advance");
            },
            async removePackageOwnedState() {
              throw new Error("completed generation must not advance");
            },
            async removeReleaseProvenance() {
              throw new Error("completed generation must not advance");
            },
            async removeSoulPackage() {
              throw new Error("completed generation must not advance");
            },
          },
          now: () => new Date("2026-09-13T10:00:00.000Z"),
        },
        request
      )
    );

    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/integrations/oim/weather/majors/2/installations/${INSTALLATION_ID}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "complete",
      scope: { installationId: INSTALLATION_ID },
    });
    expect(resolveInstalledRelease).not.toHaveBeenCalled();
  });

  it("does not accept an uninstall request without its installation generation", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/api/v1/integrations/oim/weather/majors/2",
    });

    expect(response.statusCode).toBe(404);
    expect(uninstall).not.toHaveBeenCalled();
  });

  it("returns uninstall status for the requested installation generation", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/integrations/oim/weather/majors/2/installations/${INSTALLATION_ID}/uninstall`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      scope: {
        integrationId: "weather",
        majorVersion: 2,
        installationId: INSTALLATION_ID,
      },
      status: "pending",
      activationAllowed: false,
      retryRequired: false,
    });
  });

  it("changes auto-patch only for the exact installed Integration major", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/integrations/oim/weather/majors/2/auto-patch",
      payload: { enabled: false },
    });

    expect(response.statusCode).toBe(200);
    expect(setAutoPatchPreference).toHaveBeenCalledWith({
      businessId: "business-1",
      integrationId: "weather",
      majorVersion: 2,
      enabled: false,
    });
  });

  it("sends operator-confirmed immutable recovery evidence to the recovery service", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/oim/weather/majors/1/recovery",
      payload: {
        source: "https://example.test/weather.git",
        sourceRef: "commit-a1b2c3",
        candidatePath: "packages/weather",
        slug: "weather-v1",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ installationId: INSTALLATION_ID });
    expect(recover).toHaveBeenCalledWith({
      businessId: "business-1",
      actorId: "user:operator-1",
      integrationId: "weather",
      majorVersion: 1,
      source: "https://example.test/weather.git",
      sourceRef: "commit-a1b2c3",
      candidatePath: "packages/weather",
      slug: "weather-v1",
    });
  });

  it("passes a strict signed revocation list to the trust service", async () => {
    const payload = {
      envelopeVersion: 1,
      list: {
        sequence: 2,
        issuedAt: "2026-09-13T09:00:00.000Z",
        expiresAt: "2026-09-14T09:00:00.000Z",
        revocations: [
          {
            integrationId: "weather",
            version: "1.2.3",
            packageDigest: DIGEST,
            reason: "Unsafe release",
          },
        ],
      },
      signature: {
        algorithm: "Ed25519",
        keyId: "revocations-2026",
        value: `${"A".repeat(86)}==`,
      },
    };
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/oim/release-trust/revocations",
      payload,
    });

    expect(response.statusCode).toBe(202);
    expect(acceptRevocationList).toHaveBeenCalledWith(payload);
  });
});
