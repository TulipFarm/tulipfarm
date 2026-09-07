import { generateKeyPairSync } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import {
  createEd25519OimReleaseSigner,
  signOimRelease,
  signOimRevocationList,
} from "@tulipfarm/integrations";
import { oimFileDigest, oimPackageDigest } from "@tulipfarm/schema";
import type { SoulIntegration } from "@tulipfarm/soul";
import { OIM_RELEASE_TRUST_STORAGE_STATEMENTS, OimReleaseTrustStore } from "@tulipfarm/storage";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OimReleaseTrustHost } from "./oim-release-compose";
import { createOimRuntimeHost } from "./oim-runtime-host";

function integrationFixture(): SoulIntegration {
  return {
    slug: "example",
    sourceIntegration: "example",
    oimPackageFiles: { "guide.md": "Guide" },
    oimManifest: {
      oimVersion: "1.0",
      kind: "Integration",
      metadata: {
        id: "example",
        name: "Example",
        version: "1.0.0",
        description: "Read an example value.",
        license: "Apache-2.0",
      },
      profiles: { core: "1.0" },
      files: [{ path: "guide.md", role: "guide", sha256: oimFileDigest("Guide") }],
      operations: [
        {
          id: "read",
          name: "example_read",
          description: "Read a value.",
          effect: "read",
          identityMode: "shared_only",
          source: {
            type: "http",
            method: "GET",
            baseUrl: "https://api.example.com",
            path: "/value",
          },
          response: { schema: { type: "object" }, maxBytes: 1024 },
        },
      ],
    },
  };
}

describe("OIM runtime host composition", () => {
  let database: PGlite;
  let trust: OimReleaseTrustHost;
  let integration: SoulIntegration;
  let installed: SoulIntegration[];
  let host: ReturnType<typeof createOimRuntimeHost>;

  beforeAll(async () => {
    database = new PGlite();
    for (const statement of OIM_RELEASE_TRUST_STORAGE_STATEMENTS) {
      await database.exec(statement);
    }
    trust = new OimReleaseTrustHost(
      new OimReleaseTrustStore({
        withTransaction: (run) =>
          database.transaction((transaction) =>
            run({
              query<Row>(text: string, params?: readonly unknown[]) {
                return transaction.query<Row>(text, params?.slice());
              },
            })
          ),
      })
    );
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.exec(
      "TRUNCATE oim_installed_release_provenance, oim_release_trust_roots, oim_release_revocation_state"
    );
    integration = integrationFixture();
    installed = [integration];
    host = createOimRuntimeHost({
      businessId: "deployment",
      integrations: () => installed,
      releaseTrust: trust,
    });
  });

  async function approve() {
    const manifest = integration.oimManifest;
    const files = integration.oimPackageFiles;
    if (manifest === undefined || files === undefined) throw new Error("incomplete test package");
    const authorization = await trust.authorizeInstall({
      package: { manifest, files: new Map(Object.entries(files)) },
      approvedCommunityDigest: oimPackageDigest(manifest),
    });
    await trust.recordInstalledProvenance({
      authorization,
      businessId: "deployment",
      source: "https://packages.example.com/example/oim.yml",
      originalRequirements: manifest,
      autoPatchOptIn: false,
    });
    return manifest;
  }

  const eventIdentity = {
    businessId: "deployment",
    integrationId: "example",
    integrationMajorVersion: 1,
  };

  it("requires persisted approval rather than trusting the current package digest", async () => {
    await expect(host.authorizeIntegration(integration)).rejects.toMatchObject({
      code: "installed_provenance_missing",
    });
    await approve();
    await expect(host.authorizeIntegration(integration)).resolves.toBeUndefined();
    await expect(
      host.authorizeIntegration({ ...integration, oimPackageFiles: {} })
    ).rejects.toMatchObject({ code: "installed_provenance_mismatch" });
  });

  it("checks package trust before normalizing even a package without Hooks", async () => {
    const manifest = integration.oimManifest;
    if (manifest === undefined) throw new Error("missing test manifest");
    await expect(host.hookRunnerFor({ ...eventIdentity, manifest })).rejects.toMatchObject({
      code: "installed_provenance_missing",
    });
    await approve();
    await expect(host.hookRunnerFor({ ...eventIdentity, manifest })).resolves.toBeUndefined();
    await expect(
      host.hookRunnerFor({
        ...eventIdentity,
        manifest: { ...manifest, metadata: { ...manifest.metadata, description: "Changed" } },
      })
    ).rejects.toThrow("manifest changed");
  });

  it("rechecks durable provenance before dispatching an already normalized event", async () => {
    await approve();
    await expect(host.authorizeEvent(eventIdentity)).resolves.toBeUndefined();
    await database.exec("DELETE FROM oim_installed_release_provenance");
    await expect(host.authorizeEvent(eventIdentity)).rejects.toMatchObject({
      code: "installed_provenance_missing",
    });
  });

  it("never substitutes another business, major, or duplicate installed artifact", async () => {
    await approve();
    await expect(
      host.authorizeEvent({ ...eventIdentity, businessId: "another-business" })
    ).rejects.toThrow("business does not match");
    await expect(
      host.authorizeEvent({ ...eventIdentity, integrationMajorVersion: 2 })
    ).rejects.toThrow("exactly one installed");
    installed.push({ ...integration, slug: "duplicate" });
    await expect(host.authorizeEvent(eventIdentity)).rejects.toThrow("exactly one installed");
  });

  it("fails explicitly when Hook execution is disabled", async () => {
    await expect(
      host.run(
        integration,
        { kind: "response_normalize", file: "hook.mjs", export: "normalize" },
        {}
      )
    ).rejects.toThrow("HOOKS_DISABLED");
  });

  it("loads the stored signature and rechecks revocation before every Hook execution", async () => {
    async function signer(purpose: "release" | "revocation") {
      const pair = generateKeyPairSync("ed25519");
      await trust.addRoot({
        purpose,
        keyId: purpose,
        publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
        actorId: "operator",
      });
      return createEd25519OimReleaseSigner(
        purpose,
        pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
      );
    }
    const releaseSigner = await signer("release");
    const revocationSigner = await signer("revocation");
    const now = Date.now();
    const expiresAt = new Date(now + 86_400_000).toISOString();
    await trust.acceptRevocationList(
      signOimRevocationList(
        {
          sequence: 1,
          issuedAt: new Date(now - 60_000).toISOString(),
          expiresAt,
          revocations: [],
        },
        revocationSigner
      )
    );
    const source = "export function normalize(input) { return input.payload; }";
    const hook = {
      kind: "response_normalize",
      file: "normalize.mjs",
      export: "normalize",
    } as const;
    const original = integration.oimManifest;
    if (original === undefined) throw new Error("missing test manifest");
    const manifest = {
      ...original,
      profiles: { ...original.profiles, hooks: "1.0" as const },
      hooks: [hook],
      files: [
        ...(original.files ?? []),
        { path: hook.file, role: "hook" as const, sha256: oimFileDigest(source) },
      ],
    };
    const files = { ...integration.oimPackageFiles, [hook.file]: source };
    integration = { ...integration, oimManifest: manifest, oimPackageFiles: files };
    installed = [integration];
    const exactPackage = { manifest, files: new Map(Object.entries(files)) };
    const authorization = await trust.authorizeInstall({
      package: exactPackage,
      signedRelease: signOimRelease(exactPackage, releaseSigner),
    });
    await trust.recordInstalledProvenance({
      authorization,
      businessId: "deployment",
      source: "https://packages.example.com/example/oim.yml",
      originalRequirements: manifest,
      autoPatchOptIn: false,
    });
    const runPureHook = vi.fn(async () => ({ value: "normalized" }));
    host = createOimRuntimeHost({
      businessId: "deployment",
      integrations: () => installed,
      releaseTrust: trust,
      hookExecutor: { runPureHook },
    });
    await expect(host.run(integration, hook, { payload: {} })).resolves.toEqual({
      value: "normalized",
    });
    expect(runPureHook).toHaveBeenCalledWith(
      expect.objectContaining({
        source,
        sourceSha256: oimFileDigest(source),
        exportName: "normalize",
      })
    );
    await trust.acceptRevocationList(
      signOimRevocationList(
        {
          sequence: 2,
          issuedAt: new Date(now).toISOString(),
          expiresAt,
          revocations: [
            {
              integrationId: "example",
              version: "1.0.0",
              packageDigest: oimPackageDigest(manifest),
              reason: "Withdrawn release",
            },
          ],
        },
        revocationSigner
      )
    );
    await expect(host.run(integration, hook, { payload: {} })).rejects.toMatchObject({
      code: "RELEASE_REVOKED",
    });
    expect(runPureHook).toHaveBeenCalledTimes(1);
  });
});
