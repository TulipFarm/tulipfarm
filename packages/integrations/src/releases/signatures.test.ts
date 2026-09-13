import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createEd25519OimReleaseSigner,
  signOimRelease,
  signOimRevocationList,
  verifySignedOimRelease,
  verifySignedOimRevocationList,
} from "./signatures";
import { releasePackageFixture } from "./test-fixtures";

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

describe("OIM release signatures", () => {
  it("cryptographically binds the exact Integration id, version, and package digest", () => {
    const key = testKey("release-2026");
    const package_ = releasePackageFixture({
      files: { "setup-guide.md": "# Set up Weather\n" },
    });
    const signedRelease = signOimRelease(
      package_,
      createEd25519OimReleaseSigner(key.keyId, key.privateKeyPem)
    );

    expect(
      verifySignedOimRelease(package_, signedRelease, [
        { keyId: key.keyId, publicKeyPem: key.publicKeyPem },
      ])
    ).toMatchObject({
      integrationId: "weather",
      version: "1.2.3",
      packageDigest: signedRelease.release.packageDigest,
      signerKeyId: "release-2026",
      signedRelease,
    });
  });

  describe("OIM release revocation signatures", () => {
    it("cryptographically binds a canonical, domain-separated revocation list", () => {
      const key = testKey("revocations-2026");
      const signedRevocations = signOimRevocationList(
        {
          sequence: 7,
          issuedAt: "2026-09-13T09:00:00.000Z",
          expiresAt: "2026-09-14T09:00:00.000Z",
          revocations: [
            {
              integrationId: "weather",
              version: "1.2.3",
              packageDigest: "b".repeat(64),
              reason: "Unsafe response handling",
            },
            {
              integrationId: "calendar",
              version: "2.0.1",
              packageDigest: "a".repeat(64),
              reason: "Credential exposure",
            },
          ],
        },
        createEd25519OimReleaseSigner(key.keyId, key.privateKeyPem)
      );

      expect(
        verifySignedOimRevocationList(signedRevocations, [
          { keyId: key.keyId, publicKeyPem: key.publicKeyPem },
        ])
      ).toMatchObject({
        sequence: 7,
        issuedAt: "2026-09-13T09:00:00.000Z",
        expiresAt: "2026-09-14T09:00:00.000Z",
        revocations: [
          {
            integrationId: "calendar",
            version: "2.0.1",
            packageDigest: "a".repeat(64),
            reason: "Credential exposure",
          },
          {
            integrationId: "weather",
            version: "1.2.3",
            packageDigest: "b".repeat(64),
            reason: "Unsafe response handling",
          },
        ],
        signerKeyId: "revocations-2026",
        signedRevocationList: signedRevocations,
      });
    });

    it("rejects release signatures replayed as revocation signatures", () => {
      const key = testKey("release-2026");
      const package_ = releasePackageFixture();
      const signedRelease = signOimRelease(
        package_,
        createEd25519OimReleaseSigner(key.keyId, key.privateKeyPem)
      );
      const forged = {
        envelopeVersion: 1,
        list: {
          sequence: 1,
          issuedAt: "2026-09-13T09:00:00.000Z",
          expiresAt: "2026-09-14T09:00:00.000Z",
          revocations: [],
        },
        signature: signedRelease.signature,
      };

      expect(() =>
        verifySignedOimRevocationList(forged, [
          { keyId: key.keyId, publicKeyPem: key.publicKeyPem },
        ])
      ).toThrow(expect.objectContaining({ code: "REVOCATION_SIGNATURE_INVALID" }));
    });

    it("cryptographically binds each revocation reason", () => {
      const key = testKey("revocations-2026");
      const signed = signOimRevocationList(
        {
          sequence: 1,
          issuedAt: "2026-09-13T09:00:00.000Z",
          expiresAt: "2026-09-14T09:00:00.000Z",
          revocations: [
            {
              integrationId: "weather",
              version: "1.2.3",
              packageDigest: "a".repeat(64),
              reason: "Original reason",
            },
          ],
        },
        createEd25519OimReleaseSigner(key.keyId, key.privateKeyPem)
      );
      const tampered = {
        ...signed,
        list: {
          ...signed.list,
          revocations: [{ ...signed.list.revocations[0], reason: "Changed reason" }],
        },
      };

      expect(() =>
        verifySignedOimRevocationList(tampered, [
          { keyId: key.keyId, publicKeyPem: key.publicKeyPem },
        ])
      ).toThrow(expect.objectContaining({ code: "REVOCATION_SIGNATURE_INVALID" }));
    });

    it.each([
      {
        name: "duplicate identities",
        change: {
          revocations: [
            {
              integrationId: "weather",
              version: "1.2.3",
              packageDigest: "a".repeat(64),
              reason: "Unsafe release",
            },
            {
              integrationId: "weather",
              version: "1.2.3",
              packageDigest: "a".repeat(64),
              reason: "Duplicate release",
            },
          ],
        },
      },
      { name: "non-canonical issued timestamp", change: { issuedAt: "2026-09-13T09:00:00Z" } },
      { name: "non-positive sequence", change: { sequence: 0 } },
      {
        name: "invalid version",
        change: { revocations: [{ integrationId: "weather", version: "1" }] },
      },
      {
        name: "missing reason",
        change: { revocations: [{ reason: undefined }] },
      },
      {
        name: "inverted validity window",
        change: {
          issuedAt: "2026-09-14T09:00:00.000Z",
          expiresAt: "2026-09-13T09:00:00.000Z",
        },
      },
    ])("rejects malformed revocation lists: $name", ({ change }) => {
      const key = testKey("revocations-2026");
      const signer = createEd25519OimReleaseSigner(key.keyId, key.privateKeyPem);
      const identity = {
        integrationId: "weather",
        version: "1.2.3",
        packageDigest: "a".repeat(64),
        reason: "Unsafe release",
      };
      const signed = signOimRevocationList(
        {
          sequence: 1,
          issuedAt: "2026-09-13T09:00:00.000Z",
          expiresAt: "2026-09-14T09:00:00.000Z",
          revocations: [identity],
        },
        signer
      );
      const revocations =
        "revocations" in change && Array.isArray(change.revocations)
          ? change.revocations.map((entry) => ({ ...identity, ...entry }))
          : signed.list.revocations;
      const malformed = {
        ...signed,
        list: { ...signed.list, ...change, revocations },
      };

      expect(() =>
        verifySignedOimRevocationList(malformed, [
          { keyId: key.keyId, publicKeyPem: key.publicKeyPem },
        ])
      ).toThrow(expect.objectContaining({ code: "REVOCATION_ENVELOPE_INVALID" }));
    });
  });

  it.each([
    releasePackageFixture({ integrationId: "forecast" }),
    releasePackageFixture({ version: "1.2.4" }),
    (() => {
      const package_ = releasePackageFixture();
      return {
        ...package_,
        manifest: {
          ...package_.manifest,
          metadata: {
            ...package_.manifest.metadata,
            description: "Changed package bytes.",
          },
        },
      };
    })(),
  ])("rejects a valid signature for the wrong package identity", (wrongPackage) => {
    const key = testKey("release-2026");
    const signedRelease = signOimRelease(
      releasePackageFixture(),
      createEd25519OimReleaseSigner(key.keyId, key.privateKeyPem)
    );

    expect(() =>
      verifySignedOimRelease(wrongPackage, signedRelease, [
        { keyId: key.keyId, publicKeyPem: key.publicKeyPem },
      ])
    ).toThrow(expect.objectContaining({ code: "RELEASE_IDENTITY_MISMATCH" }));
  });

  it.each(["integrationId", "version", "packageDigest"] as const)(
    "rejects a tampered signed %s",
    (field) => {
      const key = testKey("release-2026");
      const package_ = releasePackageFixture();
      const signedRelease = signOimRelease(
        package_,
        createEd25519OimReleaseSigner(key.keyId, key.privateKeyPem)
      );
      const changed =
        field === "integrationId" ? "forecast" : field === "version" ? "1.2.4" : "0".repeat(64);

      expect(() =>
        verifySignedOimRelease(
          {
            ...package_,
          },
          {
            ...signedRelease,
            release: { ...signedRelease.release, [field]: changed },
          },
          [{ keyId: key.keyId, publicKeyPem: key.publicKeyPem }]
        )
      ).toThrow(expect.objectContaining({ code: "RELEASE_SIGNATURE_INVALID" }));
    }
  );

  it("rejects unknown keys and a forged signature reusing a trusted key id", () => {
    const trusted = testKey("release-2026");
    const unknown = testKey("release-unknown");
    const package_ = releasePackageFixture();

    const unknownEnvelope = signOimRelease(
      package_,
      createEd25519OimReleaseSigner(unknown.keyId, unknown.privateKeyPem)
    );
    expect(() =>
      verifySignedOimRelease(package_, unknownEnvelope, [
        { keyId: trusted.keyId, publicKeyPem: trusted.publicKeyPem },
      ])
    ).toThrow(expect.objectContaining({ code: "RELEASE_SIGNER_UNKNOWN" }));

    const forgedEnvelope = signOimRelease(
      package_,
      createEd25519OimReleaseSigner(trusted.keyId, unknown.privateKeyPem)
    );
    expect(() =>
      verifySignedOimRelease(package_, forgedEnvelope, [
        { keyId: trusted.keyId, publicKeyPem: trusted.publicKeyPem },
      ])
    ).toThrow(expect.objectContaining({ code: "RELEASE_SIGNATURE_INVALID" }));
  });

  it.each([
    { name: "wrong algorithm", signature: { algorithm: "ed25519" } },
    { name: "unpadded base64", signature: { value: undefined } },
    { name: "base64 with whitespace", signature: { value: undefined } },
    { name: "hex", signature: { value: "00".repeat(64) } },
    { name: "unsafe key id", signature: { keyId: "release\n2026" } },
    { name: "extra envelope field", envelope: { unexpected: true } },
  ])("rejects malformed envelopes: $name", (change) => {
    const key = testKey("release-2026");
    const package_ = releasePackageFixture();
    const signedRelease = signOimRelease(
      package_,
      createEd25519OimReleaseSigner(key.keyId, key.privateKeyPem)
    );
    const value =
      change.name === "unpadded base64"
        ? signedRelease.signature.value.replace(/=+$/, "")
        : change.name === "base64 with whitespace"
          ? ` ${signedRelease.signature.value}`
          : change.signature?.value;
    const envelope = {
      ...signedRelease,
      ...change.envelope,
      ...(change.signature === undefined
        ? {}
        : {
            signature: {
              ...signedRelease.signature,
              ...change.signature,
              ...(value === undefined ? {} : { value }),
            },
          }),
    };

    expect(() =>
      verifySignedOimRelease(package_, envelope, [
        { keyId: key.keyId, publicKeyPem: key.publicKeyPem },
      ])
    ).toThrow(expect.objectContaining({ code: "RELEASE_ENVELOPE_INVALID" }));
  });

  it("accepts only Ed25519 public trust roots and Ed25519 private signing keys", () => {
    const ed25519 = testKey("release-2026");
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPrivate = rsa.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const rsaPublic = rsa.publicKey.export({ format: "pem", type: "spki" }).toString();
    const package_ = releasePackageFixture();
    const signedRelease = signOimRelease(
      package_,
      createEd25519OimReleaseSigner(ed25519.keyId, ed25519.privateKeyPem)
    );

    expect(() => createEd25519OimReleaseSigner("rsa", rsaPrivate)).toThrow(
      expect.objectContaining({ code: "SIGNING_KEY_INVALID" })
    );
    expect(() =>
      verifySignedOimRelease(package_, signedRelease, [
        { keyId: ed25519.keyId, publicKeyPem: ed25519.privateKeyPem },
      ])
    ).toThrow(expect.objectContaining({ code: "TRUSTED_KEY_INVALID" }));
    expect(() =>
      verifySignedOimRelease(package_, signedRelease, [
        { keyId: ed25519.keyId, publicKeyPem: rsaPublic },
      ])
    ).toThrow(expect.objectContaining({ code: "TRUSTED_KEY_INVALID" }));
  });

  it("rejects duplicate trusted key ids", () => {
    const key = testKey("release-2026");
    const package_ = releasePackageFixture();
    const signedRelease = signOimRelease(
      package_,
      createEd25519OimReleaseSigner(key.keyId, key.privateKeyPem)
    );

    expect(() =>
      verifySignedOimRelease(package_, signedRelease, [
        { keyId: key.keyId, publicKeyPem: key.publicKeyPem },
        { keyId: key.keyId, publicKeyPem: key.publicKeyPem },
      ])
    ).toThrow(expect.objectContaining({ code: "TRUSTED_KEY_INVALID" }));
  });
});
