import { createHash, generateKeyPairSync } from "node:crypto";
import {
  assertOimHookExecutionGrant,
  createEd25519OimReleaseSigner,
  createOimReleaseTrustService,
  issueOimHookExecutionGrant,
  OimHttpToolAdapter,
  type OimRevocationStateStore,
  type SignedOimRevocationList,
  signOimRelease,
  signOimRevocationList,
} from "@tulipfarm/integrations";
import { HookExecutor, resolveHookWorkerPath } from "@tulipfarm/sandbox";
import type { OimManifest } from "@tulipfarm/schema";
import { oimPackageDigest } from "@tulipfarm/schema";
import type { ToolAdapterRequest } from "@tulipfarm/tool-broker";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type AssertOimHookExecutionGrant,
  createVerifiedOimHookPhaseRunner,
  executeVerifiedOimHook,
  type IssueOimHookExecutionGrant,
  type OimHookExecutionGrantView,
  type OimHookReleaseAuthorization,
  type OimOfficialHookReleaseAuthorization,
} from "./oim-hooks";

const source =
  "export function normalize(input) { return { value: (input.payload?.value ?? input.value).trim() }; }";
const sourceSha256 = createHash("sha256").update(source).digest("hex");
const hook = {
  kind: "response_normalize",
  file: "normalize.mjs",
  export: "normalize",
} as const;
const manifest = {
  oimVersion: "1.0",
  kind: "Integration",
  metadata: {
    id: "verified",
    name: "Verified",
    version: "1.0.0",
    description: "Verified fixture",
    license: "Apache-2.0",
  },
  profiles: { core: "1.2", hooks: "1.0" },
  files: [{ path: hook.file, role: "hook", sha256: sourceSha256 }],
  operations: [
    {
      id: "read",
      name: "verified_read",
      description: "Read a value",
      effect: "read",
      identityMode: "shared_only",
      source: {
        type: "http",
        method: "GET",
        baseUrl: "https://verified.example.com",
        path: "/value",
      },
      response: { schema: { type: "object" }, maxBytes: 1024 },
    },
  ],
  hooks: [hook],
} as OimManifest;
const releasePackage = {
  manifest,
  files: new Map([[hook.file, source]]),
};

class MemoryRevocationStore implements OimRevocationStateStore {
  current: SignedOimRevocationList | undefined;

  async load(): Promise<SignedOimRevocationList | undefined> {
    return this.current;
  }

  async compareAndSwap(
    expectedSequence: number | undefined,
    next: SignedOimRevocationList
  ): Promise<boolean> {
    if (this.current?.list.sequence !== expectedSequence) return false;
    this.current = structuredClone(next);
    return true;
  }
}

function signingKey(keyId: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    keyId,
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

function authorization(): OimOfficialHookReleaseAuthorization {
  return {
    trustClass: "official",
    integrationId: manifest.metadata.id,
    version: manifest.metadata.version,
    packageDigest: oimPackageDigest(manifest),
    hooksAllowed: true,
    signerKeyId: "release-2026",
    revocationSequence: 7,
    signedRelease: {
      envelopeVersion: 1,
      release: {
        integrationId: manifest.metadata.id,
        version: manifest.metadata.version,
        packageDigest: oimPackageDigest(manifest),
      },
      signature: {
        algorithm: "Ed25519",
        keyId: "release-2026",
        value: "unit-test-signature",
      },
    },
  };
}

function grant(): OimHookExecutionGrantView {
  return {
    trustClass: "official",
    integrationId: manifest.metadata.id,
    version: manifest.metadata.version,
    packageDigest: oimPackageDigest(manifest),
    signerKeyId: "release-2026",
    revocationSequence: 7,
    hookKind: hook.kind,
    file: hook.file,
    fileSha256: sourceSha256,
    exportName: hook.export,
    source,
  };
}

function grantBoundary() {
  const issued = new WeakSet<object>();
  const issueHookExecutionGrant: IssueOimHookExecutionGrant = () => {
    const value = grant();
    issued.add(value);
    return value;
  };
  const assertHookExecutionGrant: AssertOimHookExecutionGrant = (
    value
  ): asserts value is OimHookExecutionGrantView => {
    if (typeof value !== "object" || value === null || !issued.has(value)) {
      throw new Error("OIM Hook execution grant is invalid");
    }
  };
  return { issueHookExecutionGrant, assertHookExecutionGrant };
}

describe("executeVerifiedOimHook", () => {
  it("passes the original branded grant directly into bounded execution", async () => {
    const authorizeToolCompilation = vi.fn(async () => authorization());
    const boundary = grantBoundary();
    const issueHookExecutionGrant = vi.fn(boundary.issueHookExecutionGrant);
    const assertHookExecutionGrant = vi.fn(boundary.assertHookExecutionGrant);
    const runPureHook = vi.fn(async () => ({ value: "ready" }));
    const signedRelease = { signature: "opaque" };

    await expect(
      executeVerifiedOimHook(
        {
          releaseTrust: { authorizeToolCompilation },
          issueHookExecutionGrant,
          assertHookExecutionGrant,
          executor: { runPureHook },
        },
        {
          package: releasePackage,
          signedRelease,
          hook,
          value: { value: " ready " },
        }
      )
    ).resolves.toEqual({ value: "ready" });

    expect(authorizeToolCompilation).toHaveBeenCalledWith({
      package: releasePackage,
      signedRelease,
    });
    expect(issueHookExecutionGrant).toHaveBeenCalledWith(
      authorization(),
      releasePackage,
      hook.kind,
      hook.export
    );
    expect(assertHookExecutionGrant).toHaveBeenCalledOnce();
    expect(runPureHook).toHaveBeenCalledWith({
      source,
      sourceSha256,
      exportName: hook.export,
      input: { value: " ready " },
      breakerKey: `oim:${manifest.metadata.id}@${manifest.metadata.version}:${oimPackageDigest(manifest)}:${hook.kind}:${hook.export}`,
    });
  });

  describe("createVerifiedOimHookPhaseRunner", () => {
    it("binds the exact release package and authorizes every phase immediately before execution", async () => {
      const authorizeToolCompilation = vi.fn(async () => authorization());
      const boundary = grantBoundary();
      const runPureHook = vi.fn(async () => ({ value: "ready" }));
      const signedRelease = { signature: "opaque" };
      const runner = createVerifiedOimHookPhaseRunner(
        {
          releaseTrust: { authorizeToolCompilation },
          ...boundary,
          executor: { runPureHook },
        },
        {
          package: releasePackage,
          signedRelease,
        }
      );

      await expect(
        runner.run(hook, { payload: { value: " ready " }, safeHeaders: {} })
      ).resolves.toEqual({ value: "ready" });

      expect(authorizeToolCompilation).toHaveBeenCalledWith({
        package: releasePackage,
        signedRelease,
      });
      expect(runPureHook).toHaveBeenCalledOnce();
    });
  });

  describe("verified adapter composition", () => {
    let executor: HookExecutor;

    beforeAll(() => {
      executor = new HookExecutor({
        workerPath: resolveHookWorkerPath(
          `${__dirname}/../../../../packages/sandbox/src/hooks`,
          "worker"
        ),
      });
    });

    afterAll(async () => {
      await executor.close();
    });

    it("runs a redacted provider response through the signed Hook in the isolate", async () => {
      const runner = createVerifiedOimHookPhaseRunner(
        {
          releaseTrust: { authorizeToolCompilation: async () => authorization() },
          ...grantBoundary(),
          executor,
        },
        { package: releasePackage, signedRelease: { signature: "opaque" } }
      );
      const adapter = new OimHttpToolAdapter({
        manifest,
        hookRunner: runner,
        http: {
          send: async () => ({
            status: 200,
            headers: {},
            body: { value: " ready ", access_token: "provider-secret" },
          }),
        },
        binding: {
          method: "GET",
          baseUrl: "https://verified.example.com",
          pathTemplate: "/value",
          mutating: false,
          params: [],
          hasBody: false,
          headers: {},
        },
      });
      const request = {
        intent: {
          intentId: "intent-1",
          businessId: "business-1",
          runId: "run-1",
          stateId: "state-1",
          toolId: "oim.verified.v1.read",
          toolVersion: "1.0.0",
          action: "verified.read",
          targetRefs: [],
          arguments: {},
          idempotencyKey: "effect-1",
        },
        idempotencyKey: "effect-1",
        attempt: 1,
      } satisfies ToolAdapterRequest;

      await expect(adapter.dispatch(request)).resolves.toEqual({ value: "ready" });
    });

    it("verifies a real signed release and blocks the isolate after revocation", async () => {
      const releaseKey = signingKey("release-2026");
      const revocationKey = signingKey("revocations-2026");
      const releaseSigner = createEd25519OimReleaseSigner(
        releaseKey.keyId,
        releaseKey.privateKeyPem
      );
      const revocationSigner = createEd25519OimReleaseSigner(
        revocationKey.keyId,
        revocationKey.privateKeyPem
      );
      const revocationStore = new MemoryRevocationStore();
      const trust = createOimReleaseTrustService({
        trustedReleaseKeys: [releaseKey],
        trustedRevocationKeys: [revocationKey],
        revocationStore,
        now: () => new Date("2026-09-07T06:30:00.000Z"),
      });
      await trust.acceptRevocationList(
        signOimRevocationList(
          {
            sequence: 1,
            issuedAt: "2026-09-07T06:00:00.000Z",
            expiresAt: "2026-09-08T06:00:00.000Z",
            revocations: [],
          },
          revocationSigner
        )
      );
      const signedRelease = signOimRelease(releasePackage, releaseSigner);
      const runPureHook = vi.spyOn(executor, "runPureHook");
      const runner = createVerifiedOimHookPhaseRunner(
        {
          releaseTrust: trust,
          issueHookExecutionGrant: issueOimHookExecutionGrant,
          assertHookExecutionGrant: assertOimHookExecutionGrant,
          executor,
        },
        { package: releasePackage, signedRelease }
      );
      const adapter = new OimHttpToolAdapter({
        manifest,
        hookRunner: runner,
        http: {
          send: async () => ({
            status: 200,
            headers: {},
            body: { value: " ready ", access_token: "provider-secret" },
          }),
        },
        binding: {
          method: "GET",
          baseUrl: "https://verified.example.com",
          pathTemplate: "/value",
          mutating: false,
          params: [],
          hasBody: false,
          headers: {},
        },
      });
      const request = {
        intent: {
          intentId: "intent-1",
          businessId: "business-1",
          runId: "run-1",
          stateId: "state-1",
          toolId: "oim.verified.v1.read",
          toolVersion: "1.0.0",
          action: "verified.read",
          targetRefs: [],
          arguments: {},
          idempotencyKey: "effect-1",
        },
        idempotencyKey: "effect-1",
        attempt: 1,
      } satisfies ToolAdapterRequest;

      await expect(adapter.dispatch(request)).resolves.toEqual({ value: "ready" });
      expect(runPureHook).toHaveBeenCalledOnce();

      await trust.acceptRevocationList(
        signOimRevocationList(
          {
            sequence: 2,
            issuedAt: "2026-09-07T06:01:00.000Z",
            expiresAt: "2026-09-08T06:00:00.000Z",
            revocations: [{ ...signedRelease.release, reason: "Unsafe Hook" }],
          },
          revocationSigner
        )
      );

      await expect(adapter.dispatch(request)).rejects.toMatchObject({
        code: "response_normalize_hook_failed",
        phase: "after_dispatch",
      });
      expect(runPureHook).toHaveBeenCalledOnce();
    });
  });

  it.each(["community", "unsigned"] as const)(
    "denies %s provenance before calling the executor",
    async (provenance) => {
      const community: OimHookReleaseAuthorization = {
        trustClass: "community",
        integrationId: manifest.metadata.id,
        version: manifest.metadata.version,
        packageDigest: oimPackageDigest(manifest),
        hooksAllowed: false,
        approvedCommunityDigest: oimPackageDigest(manifest),
      };
      const runPureHook = vi.fn();
      const issueHookExecutionGrant: IssueOimHookExecutionGrant = () => {
        throw new Error(`OIM Hooks reject ${provenance} packages`);
      };

      await expect(
        executeVerifiedOimHook(
          {
            releaseTrust: { authorizeToolCompilation: async () => community },
            issueHookExecutionGrant,
            assertHookExecutionGrant: grantBoundary().assertHookExecutionGrant,
            executor: { runPureHook },
          },
          {
            package: releasePackage,
            hook,
            value: null,
          }
        )
      ).rejects.toThrow(`OIM Hooks reject ${provenance} packages`);
      expect(runPureHook).not.toHaveBeenCalled();
    }
  );

  it("rejects a forged or copied grant before calling the executor", async () => {
    const boundary = grantBoundary();
    const runPureHook = vi.fn();
    const issueHookExecutionGrant: IssueOimHookExecutionGrant = () => ({ ...grant() });

    await expect(
      executeVerifiedOimHook(
        {
          releaseTrust: { authorizeToolCompilation: async () => authorization() },
          issueHookExecutionGrant,
          assertHookExecutionGrant: boundary.assertHookExecutionGrant,
          executor: { runPureHook },
        },
        {
          package: releasePackage,
          signedRelease: {},
          hook,
          value: null,
        }
      )
    ).rejects.toThrow("OIM Hook execution grant is invalid");
    expect(runPureHook).not.toHaveBeenCalled();
  });

  it("surfaces trust, grant, and executor errors unchanged", async () => {
    const trustFailure = new Error("signature invalid");
    const runPureHook = vi.fn();
    const boundary = grantBoundary();

    await expect(
      executeVerifiedOimHook(
        {
          releaseTrust: {
            authorizeToolCompilation: async () => {
              throw trustFailure;
            },
          },
          ...boundary,
          executor: { runPureHook },
        },
        {
          package: releasePackage,
          signedRelease: {},
          hook,
          value: null,
        }
      )
    ).rejects.toBe(trustFailure);
    expect(runPureHook).not.toHaveBeenCalled();

    const grantFailure = new Error("hook declaration is ambiguous");
    await expect(
      executeVerifiedOimHook(
        {
          releaseTrust: { authorizeToolCompilation: async () => authorization() },
          issueHookExecutionGrant: () => {
            throw grantFailure;
          },
          assertHookExecutionGrant: boundary.assertHookExecutionGrant,
          executor: { runPureHook },
        },
        {
          package: releasePackage,
          signedRelease: {},
          hook,
          value: null,
        }
      )
    ).rejects.toBe(grantFailure);

    const executionFailure = new Error("pure hook timed out");
    await expect(
      executeVerifiedOimHook(
        {
          releaseTrust: { authorizeToolCompilation: async () => authorization() },
          ...boundary,
          executor: {
            runPureHook: async () => {
              throw executionFailure;
            },
          },
        },
        {
          package: releasePackage,
          signedRelease: {},
          hook,
          value: null,
        }
      )
    ).rejects.toBe(executionFailure);
  });
});
