import { knowledgeManifestFixture } from "@tulipfarm/integrations/src/knowledge/oim-manifest.fixture";
import { oimPackageDigest } from "@tulipfarm/schema";
import type {
  InstalledOimReleaseProvenance,
  OimRevocationFeed,
  OimTrustRoot,
} from "@tulipfarm/storage";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequireAuthorization, RouteAuthorization } from "../authz/route-gate";
import {
  OimReleaseAdminError,
  OimReleaseTrustHost,
  type OimReleaseTrustStorePort,
} from "./oim-release-compose";
import { type OimReleaseRouteService, registerOimReleaseRoutes } from "./oim-release-routes";

const ROOT = {
  purpose: "release" as const,
  keyId: "release-2026",
  publicKeyPem: "-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----\n",
  createdAt: "2026-09-07T06:00:00.000Z",
  createdBy: "admin-1",
};

class FakeReleaseService implements OimReleaseRouteService {
  roots: OimTrustRoot[] = [ROOT];
  accepted: unknown;
  feed: OimRevocationFeed | null = null;
  preference: InstalledOimReleaseProvenance = {
    businessId: "business-1",
    integrationId: "wiki",
    majorVersion: 2,
    version: "2.1.0",
    packageDigest: "a".repeat(64),
    source: "https://catalog.example/wiki/oim.yml",
    trustClass: "official",
    signedRelease: { envelopeVersion: 1 },
    originalRequirements: { metadata: { id: "wiki", version: "2.1.0" } },
    autoPatchOptIn: true,
    installedAt: "2026-09-07T06:00:00.000Z",
    updatedAt: "2026-09-07T06:00:00.000Z",
  };

  async listRoots() {
    return this.roots;
  }

  async addRoot(input: {
    purpose: "release" | "revocation";
    keyId: string;
    publicKeyPem: string;
    actorId: string;
  }) {
    const root = { ...ROOT, ...input, createdAt: ROOT.createdAt, createdBy: input.actorId };
    this.roots.push(root);
    return root;
  }

  async disableRoot(purpose: "release" | "revocation", keyId: string, actorId: string) {
    const found = this.roots.find((root) => root.purpose === purpose && root.keyId === keyId);
    if (found === undefined) throw new Error("not found");
    return {
      ...found,
      disabledAt: "2026-09-07T07:00:00.000Z",
      disabledBy: actorId,
    };
  }

  async acceptRevocationList(envelope: unknown) {
    this.accepted = envelope;
    return envelope as never;
  }

  async getRevocationFeed() {
    return this.feed;
  }

  async setRevocationFeed(url: string, actorId: string) {
    this.feed = {
      url,
      updatedAt: "2026-09-07T07:00:00.000Z",
      updatedBy: actorId,
    };
    return this.feed;
  }

  async disableRevocationFeed() {
    this.feed = null;
  }

  async getInstalledAutoPatchPreference(
    _businessId: string,
    integrationId: string,
    majorVersion: number
  ) {
    if (
      integrationId !== this.preference.integrationId ||
      majorVersion !== this.preference.majorVersion
    ) {
      throw new OimReleaseAdminError(
        "installed_release_not_found",
        `Installed OIM release ${integrationId}@${majorVersion} has no durable provenance`
      );
    }
    return this.preference;
  }

  async setInstalledAutoPatchPreference(
    _businessId: string,
    integrationId: string,
    majorVersion: number,
    enabled: boolean
  ) {
    if (
      integrationId !== this.preference.integrationId ||
      majorVersion !== this.preference.majorVersion
    ) {
      throw new OimReleaseAdminError(
        "installed_release_not_found",
        `Installed OIM release ${integrationId}@${majorVersion} has no durable provenance`
      );
    }
    if (this.preference.trustClass === "community" && enabled) {
      throw new OimReleaseAdminError(
        "community_auto_patch_forbidden",
        "Automatic OIM patch updates require a trusted Official release"
      );
    }
    this.preference = { ...this.preference, autoPatchOptIn: enabled };
    return this.preference;
  }
}

describe("OIM release trust routes", () => {
  let app: FastifyInstance;
  let service: FakeReleaseService;
  let authorizations: RouteAuthorization[];

  beforeEach(async () => {
    app = Fastify();
    service = new FakeReleaseService();
    authorizations = [];
    const requireAuth = async (req: FastifyRequest, reply: FastifyReply) => {
      if (req.headers.authorization === undefined) {
        await reply.code(401).send({ error: "authentication required" });
      } else {
        req.principal = {
          kind: "user",
          id: "admin-1",
          businessId: "business-1",
          credential: "api_token",
          authMethods: [],
          authenticatedAt: new Date("2026-09-07T06:00:00.000Z"),
        };
      }
    };
    const requireAuthorization: RequireAuthorization = (authorization) => {
      authorizations.push(authorization);
      return async (req, reply) => {
        const integrationInstaller =
          req.headers["x-install"] === "true" && authorization.action === "integration.install";
        const integrationUpdater =
          req.headers["x-update"] === "true" && authorization.action === "integration.update";
        if (req.headers["x-admin"] !== "true" && !integrationInstaller && !integrationUpdater) {
          await reply.code(403).send({ error: "forbidden" });
        }
      };
    };
    registerOimReleaseRoutes(app, service, requireAuth, requireAuthorization);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("protects operator trust roots with the Integration approval gate", async () => {
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/integrations/oim/release-trust/roots",
        })
      ).statusCode
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/integrations/oim/release-trust/roots",
          headers: { authorization: "Bearer member" },
        })
      ).statusCode
    ).toBe(403);
    expect(authorizations).toContainEqual({
      action: "deployment.oim_trust.manage",
      resourceType: "deployment",
      fallback: "admin",
    });
  });

  it("denies a member who may install Integrations from changing deployment trust", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/oim/release-trust/roots",
      headers: { authorization: "******", "x-install": "true" },
      payload: {
        purpose: "release",
        keyId: "member-key",
        publicKeyPem: ROOT.publicKeyPem,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(service.roots).toEqual([ROOT]);
  });

  it("refuses trust mutations when authentication did not attach a principal", async () => {
    const miswired = Fastify();
    registerOimReleaseRoutes(
      miswired,
      service,
      async () => undefined,
      () => async () => undefined
    );
    await miswired.ready();

    const response = await miswired.inject({
      method: "POST",
      url: "/api/v1/integrations/oim/release-trust/roots",
      payload: {
        purpose: "release",
        keyId: "unattributed-key",
        publicKeyPem: ROOT.publicKeyPem,
      },
    });

    expect(response.statusCode).toBe(401);
    expect(service.roots).toEqual([ROOT]);
    await miswired.close();
  });

  it("adds, lists, and disables only operator-supplied public roots", async () => {
    const added = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/oim/release-trust/roots",
      headers: { authorization: "Bearer admin", "x-admin": "true" },
      payload: {
        purpose: "revocation",
        keyId: "revocations-2026",
        publicKeyPem: ROOT.publicKeyPem,
      },
    });
    expect(added.statusCode).toBe(201);
    expect(added.json().root).toMatchObject({
      purpose: "revocation",
      keyId: "revocations-2026",
      createdBy: "admin-1",
    });

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/oim/release-trust/roots",
      headers: { authorization: "Bearer admin", "x-admin": "true" },
    });
    expect(listed.json().roots).toHaveLength(2);
    expect(JSON.stringify(listed.json())).not.toContain("PRIVATE KEY");

    const disabled = await app.inject({
      method: "DELETE",
      url: "/api/v1/integrations/oim/release-trust/roots/revocation/revocations-2026",
      headers: { authorization: "Bearer admin", "x-admin": "true" },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().root).toMatchObject({ disabledBy: "admin-1" });
  });

  it("does not let a remote package nominate its own trust key", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/oim/release-trust/roots",
      headers: { authorization: "******", "x-admin": "true" },
      payload: {
        purpose: "release",
        keyId: "remote-key",
        publicKeyUrl: "https://package.example/key.pem",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(service.roots).toEqual([ROOT]);
  });

  it("ingests a signed revocation envelope without accepting a remote key", async () => {
    const envelope = {
      envelopeVersion: 1,
      list: {
        sequence: 1,
        issuedAt: "2026-09-07T06:00:00.000Z",
        expiresAt: "2026-09-08T06:00:00.000Z",
        revocations: [],
      },
      signature: { algorithm: "Ed25519", keyId: "revocations-2026", value: "signed" },
    };
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/oim/release-trust/revocations",
      headers: { authorization: "Bearer admin", "x-admin": "true" },
      payload: envelope,
    });

    expect(response.statusCode).toBe(202);
    expect(service.accepted).toEqual(envelope);
    expect(response.json()).toEqual({ sequence: 1, expiresAt: envelope.list.expiresAt });
  });

  it("configures and disables the guarded signed-revocation feed", async () => {
    const configured = await app.inject({
      method: "PUT",
      url: "/api/v1/integrations/oim/release-trust/feed",
      headers: { authorization: "******", "x-admin": "true" },
      payload: { url: "https://updates.example/revocations.json" },
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.json().feed).toMatchObject({
      url: "https://updates.example/revocations.json",
      updatedBy: "admin-1",
    });

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/oim/release-trust/feed",
      headers: { authorization: "******", "x-admin": "true" },
    });
    expect(listed.json()).toEqual({ feed: configured.json().feed });

    const disabled = await app.inject({
      method: "DELETE",
      url: "/api/v1/integrations/oim/release-trust/feed",
      headers: { authorization: "******", "x-admin": "true" },
    });
    expect(disabled.statusCode).toBe(204);
    expect(service.feed).toBeNull();
  });

  it("reads and changes only the installed release automatic-patch preference", async () => {
    const read = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/oim/wiki/majors/2/auto-patch",
      headers: { authorization: "******", "x-update": "true" },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({
      integration_id: "wiki",
      major_version: 2,
      version: "2.1.0",
      support: "official",
      auto_patch_opt_in: true,
    });

    const changed = await app.inject({
      method: "PATCH",
      url: "/api/v1/integrations/oim/wiki/majors/2/auto-patch",
      headers: { authorization: "******", "x-update": "true" },
      payload: { auto_patch_opt_in: false },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({ ...read.json(), auto_patch_opt_in: false });
    expect(authorizations).toContainEqual({
      action: "integration.update",
      resourceType: "integration",
      fallback: "admin",
    });
  });

  it("does not let an installed Community release enable automatic patches", async () => {
    service.preference = {
      ...service.preference,
      trustClass: "community",
      signedRelease: undefined,
      approvedCommunityDigest: service.preference.packageDigest,
      autoPatchOptIn: false,
    };

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/integrations/oim/wiki/majors/2/auto-patch",
      headers: { authorization: "******", "x-update": "true" },
      payload: { auto_patch_opt_in: true },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "Automatic OIM patch updates require a trusted Official release",
    });
    expect(service.preference.autoPatchOptIn).toBe(false);
  });

  it("returns not found when the installed release has no durable provenance", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/oim/unknown/majors/2/auto-patch",
      headers: { authorization: "******", "x-update": "true" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: "Installed OIM release unknown@2 has no durable provenance",
    });
  });
});

describe("OimReleaseTrustHost", () => {
  it("derives runtime authorization input only from exact durable provenance", async () => {
    const manifest = knowledgeManifestFixture();
    const packageInput = { manifest, files: new Map<string, string>() };
    const packageDigest = oimPackageDigest(manifest);
    const store = {
      addTrustRoot: async () => ROOT,
      compareAndSwap: async () => false,
      disableRevocationFeed: async () => false,
      disableTrustRoot: async () => null,
      findInstalledProvenance: async () => ({
        businessId: "business-1",
        integrationId: manifest.metadata.id,
        majorVersion: 2,
        version: manifest.metadata.version,
        packageDigest,
        source: "https://community.example/oim.yml",
        trustClass: "community" as const,
        approvedCommunityDigest: packageDigest,
        originalRequirements: manifest,
        autoPatchOptIn: false,
        installedAt: "2026-09-07T06:00:00.000Z",
        updatedAt: "2026-09-07T06:00:00.000Z",
      }),
      getRevocationFeed: async () => null,
      listAutoPatchProvenance: async () => [],
      listTrustRoots: async () => [],
      load: async () => undefined,
      putInstalledProvenance: async () => undefined,
      setInstalledAutoPatchPreference: async () => null,
      setRevocationFeed: async () => {
        throw new Error("not used");
      },
    } satisfies OimReleaseTrustStorePort;
    const host = new OimReleaseTrustHost(store);

    await expect(
      host.installedAuthorizationInput({ businessId: "business-1", package: packageInput })
    ).resolves.toEqual({
      package: packageInput,
      approvedCommunityDigest: packageDigest,
    });
  });

  it("denies an installed package that does not match durable provenance", async () => {
    const manifest = knowledgeManifestFixture();
    const store = {
      addTrustRoot: async () => ROOT,
      compareAndSwap: async () => false,
      disableRevocationFeed: async () => false,
      disableTrustRoot: async () => null,
      findInstalledProvenance: async () => ({
        businessId: "business-1",
        integrationId: manifest.metadata.id,
        majorVersion: 2,
        version: manifest.metadata.version,
        packageDigest: "0".repeat(64),
        source: "https://community.example/oim.yml",
        trustClass: "community" as const,
        approvedCommunityDigest: "0".repeat(64),
        originalRequirements: manifest,
        autoPatchOptIn: false,
        installedAt: "2026-09-07T06:00:00.000Z",
        updatedAt: "2026-09-07T06:00:00.000Z",
      }),
      getRevocationFeed: async () => null,
      listAutoPatchProvenance: async () => [],
      listTrustRoots: async () => [],
      load: async () => undefined,
      putInstalledProvenance: async () => undefined,
      setInstalledAutoPatchPreference: async () => null,
      setRevocationFeed: async () => {
        throw new Error("not used");
      },
    } satisfies OimReleaseTrustStorePort;
    const host = new OimReleaseTrustHost(store);

    await expect(
      host.installedAuthorizationInput({
        businessId: "business-1",
        package: { manifest, files: new Map() },
      })
    ).rejects.toMatchObject({ code: "installed_provenance_mismatch" });
  });

  it("rejects Community automatic patch opt-in before persistence", async () => {
    const manifest = knowledgeManifestFixture();
    const packageInput = { manifest, files: new Map<string, string>() };
    const packageDigest = oimPackageDigest(manifest);
    let persisted = false;
    const store = {
      addTrustRoot: async () => ROOT,
      compareAndSwap: async () => false,
      disableRevocationFeed: async () => false,
      disableTrustRoot: async () => null,
      findInstalledProvenance: async () => null,
      getRevocationFeed: async () => null,
      listAutoPatchProvenance: async () => [],
      listTrustRoots: async () => [],
      load: async () => undefined,
      putInstalledProvenance: async () => {
        persisted = true;
      },
      setInstalledAutoPatchPreference: async () => null,
      setRevocationFeed: async () => {
        throw new Error("not used");
      },
    } satisfies OimReleaseTrustStorePort;
    const host = new OimReleaseTrustHost(store);
    const authorization = await host.authorizeInstall({
      package: packageInput,
      approvedCommunityDigest: packageDigest,
    });

    expect(() =>
      host.recordInstalledProvenance({
        authorization,
        businessId: "business-1",
        source: "https://community.example/oim.yml",
        originalRequirements: manifest,
        autoPatchOptIn: true,
      })
    ).toThrow("Automatic OIM patch updates require a trusted Official release");
    expect(persisted).toBe(false);
  });

  it("refuses private key material before storage", async () => {
    let stored = false;
    const store = {
      addTrustRoot: async () => {
        stored = true;
        return ROOT;
      },
      compareAndSwap: async () => false,
      disableRevocationFeed: async () => false,
      disableTrustRoot: async () => null,
      findInstalledProvenance: async () => null,
      getRevocationFeed: async () => null,
      listAutoPatchProvenance: async () => [],
      listTrustRoots: async () => [],
      load: async () => undefined,
      putInstalledProvenance: async () => undefined,
      setInstalledAutoPatchPreference: async () => null,
      setRevocationFeed: async () => {
        throw new Error("not used");
      },
    } satisfies OimReleaseTrustStorePort;
    const host = new OimReleaseTrustHost(store);

    await expect(
      host.addRoot({
        purpose: "release",
        keyId: "secret",
        publicKeyPem: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
        actorId: "admin-1",
      })
    ).rejects.toMatchObject({ code: "root_invalid" });
    expect(stored).toBe(false);
  });
});
