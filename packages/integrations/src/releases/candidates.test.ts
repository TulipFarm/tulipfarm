import { generateKeyPairSync } from "node:crypto";
import { oimPackageDigest } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { verifySelectedOimReleaseCandidate } from "./candidates";
import { createEd25519OimReleaseSigner, signOimRelease } from "./signatures";
import { releasePackageFixture } from "./test-fixtures";

function signingKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    keyId: "release-2026",
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

function selection(package_: ReturnType<typeof releasePackageFixture>) {
  return {
    integrationId: package_.manifest.metadata.id,
    version: package_.manifest.metadata.version,
    packageDigest: oimPackageDigest(package_.manifest),
  };
}

describe("verifySelectedOimReleaseCandidate", () => {
  it("verifies only the matching selected candidate", () => {
    const key = signingKey();
    const signer = createEd25519OimReleaseSigner(key.keyId, key.privateKeyPem);
    const unrelatedPackage = releasePackageFixture({
      integrationId: "calendar",
      files: { "setup-guide.md": "# Calendar\n" },
    });
    const unrelated = {
      ...unrelatedPackage,
      files: new Map([["setup-guide.md", "# Tampered unrelated package\n"]]),
    };
    const target = releasePackageFixture({
      files: { "setup-guide.md": "# Weather\n" },
    });
    const signedTarget = signOimRelease(target, signer);

    expect(
      verifySelectedOimReleaseCandidate(
        selection(target),
        [
          { package: unrelated, signedRelease: { malformed: true } },
          { package: target, signedRelease: signedTarget },
        ],
        [{ keyId: key.keyId, publicKeyPem: key.publicKeyPem }]
      )
    ).toMatchObject({
      integrationId: "weather",
      version: "1.2.3",
      signerKeyId: "release-2026",
      signedRelease: signedTarget,
    });
  });

  it("fails closed when no inspected candidate matches the selection", () => {
    const key = signingKey();
    const target = releasePackageFixture();
    const unrelated = releasePackageFixture({ integrationId: "calendar" });

    expect(() =>
      verifySelectedOimReleaseCandidate(
        selection(target),
        [{ package: unrelated, signedRelease: undefined }],
        [{ keyId: key.keyId, publicKeyPem: key.publicKeyPem }]
      )
    ).toThrow(expect.objectContaining({ code: "RELEASE_CANDIDATE_NOT_FOUND" }));
  });

  it("fails closed when more than one inspected candidate matches the selection", () => {
    const key = signingKey();
    const target = releasePackageFixture();
    const signedTarget = signOimRelease(
      target,
      createEd25519OimReleaseSigner(key.keyId, key.privateKeyPem)
    );

    expect(() =>
      verifySelectedOimReleaseCandidate(
        selection(target),
        [
          { package: target, signedRelease: signedTarget },
          { package: structuredClone(target), signedRelease: signedTarget },
        ],
        [{ keyId: key.keyId, publicKeyPem: key.publicKeyPem }]
      )
    ).toThrow(expect.objectContaining({ code: "RELEASE_CANDIDATE_AMBIGUOUS" }));
  });

  it("never lets another candidate's signature authorize the selected package", () => {
    const key = signingKey();
    const signer = createEd25519OimReleaseSigner(key.keyId, key.privateKeyPem);
    const target = releasePackageFixture();
    const otherVersion = releasePackageFixture({ version: "1.2.4" });

    expect(() =>
      verifySelectedOimReleaseCandidate(
        selection(target),
        [{ package: target, signedRelease: signOimRelease(otherVersion, signer) }],
        [{ keyId: key.keyId, publicKeyPem: key.publicKeyPem }]
      )
    ).toThrow(expect.objectContaining({ code: "RELEASE_IDENTITY_MISMATCH" }));
  });

  it("rejects a selection for different package bytes", () => {
    const key = signingKey();
    const target = releasePackageFixture({
      files: { "setup-guide.md": "# Weather\n" },
    });
    const changed = releasePackageFixture({
      files: { "setup-guide.md": "# Different weather package\n" },
    });

    expect(() =>
      verifySelectedOimReleaseCandidate(
        selection(changed),
        [
          {
            package: target,
            signedRelease: signOimRelease(
              target,
              createEd25519OimReleaseSigner(key.keyId, key.privateKeyPem)
            ),
          },
        ],
        [{ keyId: key.keyId, publicKeyPem: key.publicKeyPem }]
      )
    ).toThrow(expect.objectContaining({ code: "RELEASE_CANDIDATE_NOT_FOUND" }));
  });
});
