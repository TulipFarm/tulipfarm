import { generateKeyPairSync } from "node:crypto";
import { OIM_PROFILE_VERSIONS, type OimManifest, oimFileDigest } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { knowledgeManifestFixture } from "../knowledge/oim-manifest.fixture";
import { createEd25519OimReleaseSigner, signOimRelease, signOimRevocationList } from "./signatures";
import {
  assertOimHookExecutionGrant,
  assertOimHooksAllowed,
  createOimReleaseTrustService,
  issueOimHookExecutionGrant,
  type OimRevocationStateStore,
  type SignedOimRevocationList,
} from "./trust-service";

interface TestKey {
  readonly keyId: string;
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
}

function testKey(keyId: string): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    keyId,
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

class MemoryRevocationStore implements OimRevocationStateStore {
  #current: SignedOimRevocationList | undefined;

  async load(): Promise<SignedOimRevocationList | undefined> {
    return this.#current;
  }

  async compareAndSwap(
    expectedSequence: number | undefined,
    next: SignedOimRevocationList
  ): Promise<boolean> {
    if (this.#current?.list.sequence !== expectedSequence) return false;
    this.#current = structuredClone(next);
    return true;
  }
}

const NOW = new Date("2026-09-07T06:30:00.000Z");

function packageFixture(version = "2.1.0") {
  const manifest = knowledgeManifestFixture();
  return {
    manifest: {
      ...manifest,
      metadata: { ...manifest.metadata, version },
      profiles: { ...manifest.profiles, knowledge: OIM_PROFILE_VERSIONS.knowledge },
    },
    files: new Map<string, string>(),
  };
}

function packageWithHook() {
  const hook = "export function map(value) { return value; }\n";
  const manifest = packageFixture().manifest;
  return {
    manifest: {
      ...manifest,
      profiles: { ...manifest.profiles, hooks: "1.0" },
      files: [{ path: "hooks/map.js", role: "hook", sha256: oimFileDigest(hook) }],
      hooks: [{ kind: "response_normalize", file: "hooks/map.js", export: "map" }],
    } as OimManifest,
    files: new Map([["hooks/map.js", hook]]),
  };
}

function revocationList(
  signer: ReturnType<typeof createEd25519OimReleaseSigner>,
  overrides: Partial<{
    sequence: number;
    issuedAt: string;
    expiresAt: string;
    revocations: readonly {
      integrationId: string;
      version: string;
      packageDigest: string;
      reason: string;
    }[];
  }> = {}
) {
  return signOimRevocationList(
    {
      sequence: overrides.sequence ?? 1,
      issuedAt: overrides.issuedAt ?? "2026-09-07T06:00:00.000Z",
      expiresAt: overrides.expiresAt ?? "2026-09-08T06:00:00.000Z",
      revocations: overrides.revocations ?? [],
    },
    signer
  );
}

function service(
  releaseKeys: readonly TestKey[],
  revocationKeys: readonly TestKey[],
  store = new MemoryRevocationStore()
) {
  return {
    store,
    trust: createOimReleaseTrustService({
      trustedReleaseKeys: releaseKeys,
      trustedRevocationKeys: revocationKeys,
      revocationStore: store,
      now: () => NOW,
    }),
  };
}

describe("OIM release trust service", () => {
  it("binds a trusted signed release to its id, version, digest, and companion bytes", async () => {
    const releaseKey = testKey("release-2026");
    const revocationKey = testKey("revocations-2026");
    const { trust } = service([releaseKey], [revocationKey]);
    await trust.acceptRevocationList(
      revocationList(
        createEd25519OimReleaseSigner(revocationKey.keyId, revocationKey.privateKeyPem)
      )
    );

    const pkg = packageWithHook();
    const signed = signOimRelease(
      pkg,
      createEd25519OimReleaseSigner(releaseKey.keyId, releaseKey.privateKeyPem)
    );

    await expect(trust.authorizeInstall({ package: pkg, signedRelease: signed })).resolves.toEqual(
      expect.objectContaining({
        trustClass: "official",
        integrationId: "wiki",
        version: "2.1.0",
        hooksAllowed: true,
        signerKeyId: "release-2026",
      })
    );

    const tampered = {
      ...pkg,
      files: new Map([["hooks/map.js", "export function map() { return 'tampered'; }\n"]]),
    };
    await expect(
      trust.authorizeInstall({ package: tampered, signedRelease: signed })
    ).rejects.toMatchObject({ code: "PACKAGE_INVALID" });
  });

  it("issues an unforgeable Hook grant bound to reviewed source bytes", async () => {
    const releaseKey = testKey("release-2026");
    const revocationKey = testKey("revocations-2026");
    const { trust } = service([releaseKey], [revocationKey]);
    await trust.acceptRevocationList(
      revocationList(
        createEd25519OimReleaseSigner(revocationKey.keyId, revocationKey.privateKeyPem)
      )
    );
    const pkg = packageWithHook();
    const signed = signOimRelease(
      pkg,
      createEd25519OimReleaseSigner(releaseKey.keyId, releaseKey.privateKeyPem)
    );
    const authorization = await trust.authorizeToolCompilation({
      package: pkg,
      signedRelease: signed,
    });
    assertOimHooksAllowed(authorization);
    const grant = issueOimHookExecutionGrant(authorization, pkg, "response_normalize", "map");

    expect(grant).toMatchObject({
      trustClass: "official",
      packageDigest: signed.release.packageDigest,
      hookKind: "response_normalize",
      file: "hooks/map.js",
      fileSha256: pkg.manifest.files?.[0]?.sha256,
      exportName: "map",
      source: pkg.files.get("hooks/map.js"),
    });
    expect(() => assertOimHookExecutionGrant(grant)).not.toThrow();
    expect(() => assertOimHookExecutionGrant({ ...grant })).toThrow(
      expect.objectContaining({ code: "HOOK_EXECUTION_GRANT_INVALID" })
    );

    const fabricatedAuthorization = {
      ...authorization,
      trustClass: "official" as const,
      hooksAllowed: true,
    };
    expect(() =>
      issueOimHookExecutionGrant(fabricatedAuthorization, pkg, "response_normalize", "map")
    ).toThrow(expect.objectContaining({ code: "PACKAGE_AUTHORIZATION_INVALID" }));
    expect(() =>
      issueOimHookExecutionGrant({ ...authorization }, pkg, "response_normalize", "map")
    ).toThrow(expect.objectContaining({ code: "PACKAGE_AUTHORIZATION_INVALID" }));
  });

  it("rejects a release signed by the wrong signer and accepts configured rotation keys", async () => {
    const oldKey = testKey("release-old");
    const newKey = testKey("release-new");
    const wrongKey = testKey("release-wrong");
    const revocationKey = testKey("revocations");
    const { trust } = service([oldKey, newKey], [revocationKey]);
    await trust.acceptRevocationList(
      revocationList(
        createEd25519OimReleaseSigner(revocationKey.keyId, revocationKey.privateKeyPem)
      )
    );
    const pkg = packageFixture();

    for (const key of [oldKey, newKey]) {
      const signed = signOimRelease(
        pkg,
        createEd25519OimReleaseSigner(key.keyId, key.privateKeyPem)
      );
      await expect(
        trust.authorizeRuntime({ package: pkg, signedRelease: signed })
      ).resolves.toEqual(
        expect.objectContaining({ trustClass: "official", signerKeyId: key.keyId })
      );
    }

    const signedByWrongKey = signOimRelease(
      pkg,
      createEd25519OimReleaseSigner(wrongKey.keyId, wrongKey.privateKeyPem)
    );
    await expect(
      trust.authorizeInstall({ package: pkg, signedRelease: signedByWrongKey })
    ).rejects.toMatchObject({ code: "RELEASE_SIGNER_UNKNOWN" });

    const forgedSameId = signOimRelease(
      pkg,
      createEd25519OimReleaseSigner(oldKey.keyId, wrongKey.privateKeyPem)
    );
    await expect(
      trust.authorizeInstall({ package: pkg, signedRelease: forgedSameId })
    ).rejects.toMatchObject({ code: "RELEASE_SIGNATURE_INVALID" });
  });

  it("rejects a tampered signed envelope", async () => {
    const releaseKey = testKey("release");
    const revocationKey = testKey("revocations");
    const { trust } = service([releaseKey], [revocationKey]);
    await trust.acceptRevocationList(
      revocationList(
        createEd25519OimReleaseSigner(revocationKey.keyId, revocationKey.privateKeyPem)
      )
    );
    const pkg = packageFixture();
    const signed = signOimRelease(
      pkg,
      createEd25519OimReleaseSigner(releaseKey.keyId, releaseKey.privateKeyPem)
    );

    await expect(
      trust.authorizeInstall({
        package: pkg,
        signedRelease: {
          ...signed,
          release: { ...signed.release, version: "2.1.1" },
        },
      })
    ).rejects.toMatchObject({ code: "RELEASE_SIGNATURE_INVALID" });
    await expect(
      trust.authorizeInstall({
        package: pkg,
        signedRelease: { ...signed, unexpected: true },
      })
    ).rejects.toMatchObject({ code: "RELEASE_ENVELOPE_INVALID" });

    const otherVersion = packageFixture("2.1.1");
    await expect(
      trust.authorizeInstall({ package: otherVersion, signedRelease: signed })
    ).rejects.toMatchObject({ code: "RELEASE_IDENTITY_MISMATCH" });
  });

  it("denies a revoked release at install, runtime, and Tool compilation", async () => {
    const releaseKey = testKey("release");
    const revocationKey = testKey("revocations");
    const { trust } = service([releaseKey], [revocationKey]);
    const pkg = packageFixture();
    const signed = signOimRelease(
      pkg,
      createEd25519OimReleaseSigner(releaseKey.keyId, releaseKey.privateKeyPem)
    );
    await trust.acceptRevocationList(
      revocationList(
        createEd25519OimReleaseSigner(revocationKey.keyId, revocationKey.privateKeyPem),
        {
          revocations: [
            {
              ...signed.release,
              reason: "Provider credential leak",
            },
          ],
        }
      )
    );

    for (const authorize of [
      trust.authorizeInstall,
      trust.authorizeRuntime,
      trust.authorizeToolCompilation,
    ]) {
      await expect(authorize({ package: pkg, signedRelease: signed })).rejects.toMatchObject({
        code: "RELEASE_REVOKED",
      });
    }
  });

  it("rejects stale, expired, time-rollback, and wrongly signed revocation lists", async () => {
    const releaseKey = testKey("release");
    const revocationKey = testKey("revocations");
    const wrongKey = testKey("wrong");
    const { trust } = service([releaseKey], [revocationKey]);
    const signer = createEd25519OimReleaseSigner(revocationKey.keyId, revocationKey.privateKeyPem);
    await trust.acceptRevocationList(revocationList(signer));

    await expect(trust.acceptRevocationList(revocationList(signer))).rejects.toMatchObject({
      code: "REVOCATION_SEQUENCE_STALE",
    });
    await expect(
      trust.acceptRevocationList(
        revocationList(signer, {
          sequence: 2,
          issuedAt: "2026-09-07T05:59:59.000Z",
        })
      )
    ).rejects.toMatchObject({ code: "REVOCATION_TIME_ROLLBACK" });
    await expect(
      trust.acceptRevocationList(
        revocationList(signer, {
          sequence: 2,
          issuedAt: "2026-09-06T05:00:00.000Z",
          expiresAt: "2026-09-07T06:29:59.000Z",
        })
      )
    ).rejects.toMatchObject({ code: "REVOCATION_LIST_EXPIRED" });
    await expect(
      trust.acceptRevocationList(
        revocationList(createEd25519OimReleaseSigner(wrongKey.keyId, wrongKey.privateKeyPem), {
          sequence: 2,
          issuedAt: "2026-09-07T06:01:00.000Z",
        })
      )
    ).rejects.toMatchObject({ code: "REVOCATION_SIGNER_UNKNOWN" });

    const revokedEntry = {
      integrationId: "wiki",
      version: "2.1.0",
      packageDigest: "a".repeat(64),
      reason: "Original reason",
    };
    const signedList = revocationList(signer, {
      sequence: 2,
      issuedAt: "2026-09-07T06:01:00.000Z",
      revocations: [revokedEntry],
    });
    const tampered = {
      ...signedList,
      list: {
        ...signedList.list,
        revocations: [{ ...revokedEntry, reason: "Changed reason" }],
      },
    };
    await expect(trust.acceptRevocationList(tampered)).rejects.toMatchObject({
      code: "REVOCATION_LIST_INVALID",
    });
  });

  it("keeps revocations monotonic while rotating revocation signing keys", async () => {
    const releaseKey = testKey("release");
    const oldRevocationKey = testKey("revocations-old");
    const newRevocationKey = testKey("revocations-new");
    const { trust } = service([releaseKey], [oldRevocationKey, newRevocationKey]);
    const revoked = signOimRelease(
      packageFixture(),
      createEd25519OimReleaseSigner(releaseKey.keyId, releaseKey.privateKeyPem)
    ).release;
    const oldSigner = createEd25519OimReleaseSigner(
      oldRevocationKey.keyId,
      oldRevocationKey.privateKeyPem
    );
    const newSigner = createEd25519OimReleaseSigner(
      newRevocationKey.keyId,
      newRevocationKey.privateKeyPem
    );
    const entries = [{ ...revoked, reason: "Unsafe release" }];
    await trust.acceptRevocationList(revocationList(oldSigner, { revocations: entries }));
    await expect(
      trust.acceptRevocationList(
        revocationList(newSigner, {
          sequence: 2,
          issuedAt: "2026-09-07T06:01:00.000Z",
          revocations: entries,
        })
      )
    ).resolves.toBeUndefined();
    await expect(
      trust.acceptRevocationList(
        revocationList(newSigner, {
          sequence: 3,
          issuedAt: "2026-09-07T06:02:00.000Z",
          revocations: [],
        })
      )
    ).rejects.toMatchObject({ code: "REVOCATION_SET_ROLLBACK" });
  });

  it("fails closed when official revocation state is missing or expired", async () => {
    const releaseKey = testKey("release");
    const revocationKey = testKey("revocations");
    const signer = createEd25519OimReleaseSigner(releaseKey.keyId, releaseKey.privateKeyPem);
    const revocationSigner = createEd25519OimReleaseSigner(
      revocationKey.keyId,
      revocationKey.privateKeyPem
    );
    const pkg = packageFixture();
    const signedRelease = signOimRelease(pkg, signer);

    const missing = service([releaseKey], [revocationKey]);
    await expect(
      missing.trust.authorizeRuntime({ package: pkg, signedRelease })
    ).rejects.toMatchObject({ code: "REVOCATION_LIST_MISSING" });

    const expiredStore = new MemoryRevocationStore();
    await expiredStore.compareAndSwap(
      undefined,
      revocationList(revocationSigner, {
        issuedAt: "2026-09-06T06:00:00.000Z",
        expiresAt: "2026-09-07T06:29:59.000Z",
      })
    );
    const expired = service([releaseKey], [revocationKey], expiredStore);
    await expect(
      expired.trust.authorizeInstall({ package: pkg, signedRelease })
    ).rejects.toMatchObject({ code: "REVOCATION_LIST_EXPIRED" });
  });

  it("allows exact-digest unsigned Community packages but never their Hooks", async () => {
    const { trust } = service([], []);
    const community = packageFixture();
    const digest = signOimRelease(
      community,
      createEd25519OimReleaseSigner("fixture", testKey("fixture").privateKeyPem)
    ).release.packageDigest;

    await expect(
      trust.authorizeInstall({ package: community, approvedCommunityDigest: digest })
    ).resolves.toEqual(expect.objectContaining({ trustClass: "community", hooksAllowed: false }));
    await expect(
      trust.authorizeInstall({
        package: community,
        approvedCommunityDigest: "0".repeat(64),
      })
    ).rejects.toMatchObject({ code: "COMMUNITY_DIGEST_APPROVAL_REQUIRED" });

    const hooks = packageWithHook();
    const hookDigest = signOimRelease(
      hooks,
      createEd25519OimReleaseSigner("fixture", testKey("fixture-2").privateKeyPem)
    ).release.packageDigest;
    await expect(
      trust.authorizeToolCompilation({
        package: hooks,
        approvedCommunityDigest: hookDigest,
      })
    ).rejects.toMatchObject({ code: "HOOKS_REQUIRE_OFFICIAL_SIGNATURE" });

    const authorization = await trust.authorizeRuntime({
      package: community,
      approvedCommunityDigest: digest,
    });
    expect(() => assertOimHooksAllowed(authorization)).toThrow(
      expect.objectContaining({ code: "HOOKS_REQUIRE_OFFICIAL_SIGNATURE" })
    );
  });

  it("honors explicit opt-out and preserves original requirements for automatic official patches", async () => {
    const releaseKey = testKey("release");
    const revocationKey = testKey("revocations");
    const { trust } = service([releaseKey], [revocationKey]);
    await trust.acceptRevocationList(
      revocationList(
        createEd25519OimReleaseSigner(revocationKey.keyId, revocationKey.privateKeyPem)
      )
    );
    const signer = createEd25519OimReleaseSigner(releaseKey.keyId, releaseKey.privateKeyPem);
    const original = packageFixture("2.1.0");
    const current = packageFixture("2.1.1");
    const candidate = packageFixture("2.1.2");
    const signedCurrent = signOimRelease(current, signer);
    const signedCandidate = signOimRelease(candidate, signer);

    await expect(
      trust.authorizeAutoPatch({
        optedIn: false,
        originalRequirements: original.manifest,
        current: { package: current, signedRelease: signedCurrent },
        candidate: { package: candidate, signedRelease: signedCandidate },
      })
    ).rejects.toMatchObject({ code: "AUTO_PATCH_NOT_ALLOWED" });

    await expect(
      trust.authorizeAutoPatch({
        optedIn: true,
        originalRequirements: original.manifest,
        current: { package: current, signedRelease: signedCurrent },
        candidate: { package: candidate, signedRelease: signedCandidate },
      })
    ).resolves.toEqual(expect.objectContaining({ trustClass: "official", version: "2.1.2" }));

    const [first, ...remaining] = candidate.manifest.operations;
    const incompatible = {
      ...candidate,
      manifest: {
        ...candidate.manifest,
        operations: [{ ...first, name: "renamed_list_spaces" }, ...remaining],
      },
    };
    await expect(
      trust.authorizeAutoPatch({
        optedIn: true,
        originalRequirements: original.manifest,
        current: { package: current, signedRelease: signedCurrent },
        candidate: { package: incompatible, signedRelease: signOimRelease(incompatible, signer) },
      })
    ).rejects.toMatchObject({ code: "AUTO_PATCH_NOT_ALLOWED" });

    for (const version of ["2.2.0", "3.0.0"]) {
      const nonPatch = packageFixture(version);
      await expect(
        trust.authorizeAutoPatch({
          optedIn: true,
          originalRequirements: original.manifest,
          current: { package: current, signedRelease: signedCurrent },
          candidate: { package: nonPatch, signedRelease: signOimRelease(nonPatch, signer) },
        })
      ).rejects.toMatchObject({ code: "AUTO_PATCH_NOT_ALLOWED" });
    }

    await expect(
      trust.authorizeAutoPatch({
        optedIn: true,
        originalRequirements: original.manifest,
        current: { package: current, signedRelease: signedCurrent },
        candidate: { package: candidate },
      })
    ).rejects.toMatchObject({ code: "AUTO_PATCH_NOT_ALLOWED" });
  });

  it("never automatically applies a revoked Official patch", async () => {
    const releaseKey = testKey("release");
    const revocationKey = testKey("revocations");
    const { trust } = service([releaseKey], [revocationKey]);
    const signer = createEd25519OimReleaseSigner(releaseKey.keyId, releaseKey.privateKeyPem);
    const current = packageFixture("2.1.0");
    const candidate = packageFixture("2.1.1");
    const signedCandidate = signOimRelease(candidate, signer);
    await trust.acceptRevocationList(
      revocationList(
        createEd25519OimReleaseSigner(revocationKey.keyId, revocationKey.privateKeyPem),
        { revocations: [{ ...signedCandidate.release, reason: "unsafe" }] }
      )
    );

    await expect(
      trust.authorizeAutoPatch({
        optedIn: true,
        originalRequirements: current.manifest,
        current: { package: current, signedRelease: signOimRelease(current, signer) },
        candidate: { package: candidate, signedRelease: signedCandidate },
      })
    ).rejects.toMatchObject({ code: "RELEASE_REVOKED" });
  });
});
