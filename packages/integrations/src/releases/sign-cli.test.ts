import { generateKeyPairSync } from "node:crypto";
import { OIM_PROFILE_VERSIONS } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { knowledgeManifestFixture } from "../knowledge/oim-manifest.fixture";
import { runOimSigningCli, type SigningCliIo } from "./sign-cli";

function privateKeyPem(): string {
  return generateKeyPairSync("ed25519")
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();
}

function io(files: Readonly<Record<string, string>>) {
  const written = new Map<string, string>();
  const adapter: SigningCliIo = {
    readFile: async (path) => {
      const value = files[path];
      if (value === undefined) throw new Error(`missing ${path}`);
      return new TextEncoder().encode(value);
    },
    realpath: async (path) => path,
    writeFileExclusive: async (path, content) => {
      if (written.has(path)) throw new Error(`exists ${path}`);
      written.set(path, content);
    },
  };
  return { adapter, written };
}

describe("OIM offline signing CLI", () => {
  it("signs an exact local package without emitting private key material", async () => {
    const manifest = knowledgeManifestFixture();
    const validManifest = {
      ...manifest,
      profiles: { ...manifest.profiles, knowledge: OIM_PROFILE_VERSIONS.knowledge },
    };
    const key = privateKeyPem();
    const files = io({
      "/keys/release.pem": key,
      "/repo/package/manifest.yml": JSON.stringify(validManifest),
    });

    await runOimSigningCli(
      [
        "release",
        "--manifest",
        "/repo/package/manifest.yml",
        "--private-key",
        "/keys/release.pem",
        "--key-id",
        "release-2026",
        "--output",
        "/repo/release-envelope.json",
      ],
      files.adapter,
      "/repo"
    );

    const output = files.written.get("/repo/release-envelope.json") ?? "";
    expect(JSON.parse(output)).toMatchObject({
      envelopeVersion: 1,
      release: {
        integrationId: "wiki",
        version: "2.1.0",
      },
      signature: { algorithm: "Ed25519", keyId: "release-2026" },
    });
    expect(output).not.toContain(key);
  });

  it("refuses a private key stored inside the repository", async () => {
    const files = io({ "/repo/release.pem": privateKeyPem() });
    await expect(
      runOimSigningCli(
        [
          "revocations",
          "--input",
          "/repo/revocations.json",
          "--private-key",
          "/repo/release.pem",
          "--key-id",
          "revocations-2026",
          "--output",
          "/repo/revocations.signed.json",
        ],
        files.adapter,
        "/repo"
      )
    ).rejects.toThrow("outside the repository");
    expect(files.written.size).toBe(0);
  });

  it("signs a local revocation list without publishing or fetching anything", async () => {
    const key = privateKeyPem();
    const files = io({
      "/keys/revocations.pem": key,
      "/repo/revocations.json": JSON.stringify({
        sequence: 1,
        issuedAt: "2026-09-07T06:00:00.000Z",
        expiresAt: "2026-09-08T06:00:00.000Z",
        revocations: [],
      }),
    });

    await runOimSigningCli(
      [
        "revocations",
        "--input",
        "/repo/revocations.json",
        "--private-key",
        "/keys/revocations.pem",
        "--key-id",
        "revocations-2026",
        "--output",
        "/repo/revocations.signed.json",
      ],
      files.adapter,
      "/repo"
    );

    const output = files.written.get("/repo/revocations.signed.json") ?? "";
    expect(JSON.parse(output)).toMatchObject({
      envelopeVersion: 1,
      list: { sequence: 1, revocations: [] },
      signature: { algorithm: "Ed25519", keyId: "revocations-2026" },
    });
    expect(output).not.toContain(key);
  });
});
