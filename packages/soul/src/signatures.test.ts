import { generateKeyPairSync } from "node:crypto";
import type { VersionedSchemaDocument } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { BundleError, computeBundleDigest, type ExecutionBundle } from "./bundle";
import { compileExecutionBundle } from "./compiler";
import {
  type BundleSigner,
  createEd25519BundleSigner,
  createEd25519BundleVerifier,
  signExecutionBundle,
  verifierFromSigner,
  verifyExecutionBundle,
} from "./signatures";

const API = "tulipfarm.ai/v1";

function agent(slug: string): VersionedSchemaDocument {
  return {
    apiVersion: API,
    kind: "Agent",
    metadata: {
      id: `id-${slug}`,
      slug,
      schemaVersion: 1,
      authoredVersion: 2,
      lifecycle: "published",
    },
    spec: { instructions: "be helpful" },
  } as unknown as VersionedSchemaDocument;
}

function bundle(lineage: { changesetId?: string; commitSha?: string } = {}): ExecutionBundle {
  return compileExecutionBundle({
    businessId: "biz-1",
    changesetId: lineage.changesetId ?? "cs-1",
    commitSha: lineage.commitSha ?? "c0ffee",
    documents: [agent("triage")],
  });
}

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

function signerFor(key: TestKey): BundleSigner {
  return createEd25519BundleSigner(key.keyId, key.privateKeyPem);
}

const key = testKey("k1");
const signer = signerFor(key);
const verifier = createEd25519BundleVerifier([key]);

describe("signExecutionBundle / verifyExecutionBundle", () => {
  it("opens a signed bundle for execution without any Git access", () => {
    const record = signExecutionBundle(bundle(), signer);
    const runtime = verifyExecutionBundle(record, verifier);
    expect(runtime.digest).toBe(record.digest);
    expect(runtime.commitSha).toBe("c0ffee");
    expect(runtime.get("Agent", "triage")?.authoredVersion).toBe(2);
    expect(runtime.getById("id-triage")?.slug).toBe("triage");
    expect(runtime.get("Agent", "unknown")).toBeUndefined();
    expect(Object.isFrozen(runtime.get("Agent", "triage")?.document.spec)).toBe(true);
  });

  it("detaches the verified runtime view from an untrusted stored record", () => {
    const record = structuredClone(signExecutionBundle(bundle(), signer));
    const runtime = verifyExecutionBundle(record, verifier);

    (record.bundle.definitions[0].document.spec as Record<string, unknown>).instructions = "exfil";

    expect(
      (runtime.get("Agent", "triage")?.document.spec as Record<string, unknown>).instructions
    ).toBe("be helpful");
  });

  it("is deterministic: the same tree signs to the same digest and signature", () => {
    const first = signExecutionBundle(bundle(), signer);
    const second = signExecutionBundle(bundle(), signer);
    expect(second.digest).toBe(first.digest);
    expect(second.signature).toEqual(first.signature);
  });

  it("detects a tampered definition", () => {
    const record = structuredClone(signExecutionBundle(bundle(), signer));
    (record.bundle.definitions[0].document.spec as Record<string, unknown>).instructions = "exfil";
    expect(() => verifyExecutionBundle(record, verifier)).toThrow(
      expect.objectContaining({ code: "DIGEST_MISMATCH" })
    );
  });

  it("catches a tampered commitSha even though lineage is outside the digest", () => {
    // The content-only digest no longer changes when commitSha alone is edited, so this proves the
    // signature payload (which binds commit) is what closes the tamper hole.
    const record = structuredClone(signExecutionBundle(bundle(), signer));
    (record.bundle as { commitSha: string }).commitSha = "forged-commit";
    expect(computeBundleDigest(record.bundle)).toBe(record.digest);
    expect(() => verifyExecutionBundle(record, verifier)).toThrow(
      expect.objectContaining({ code: "SIGNATURE_INVALID" })
    );
  });

  it("catches a tampered changesetId even though lineage is outside the digest", () => {
    const record = structuredClone(signExecutionBundle(bundle(), signer));
    (record.bundle as { changesetId: string }).changesetId = "forged-changeset";
    expect(computeBundleDigest(record.bundle)).toBe(record.digest);
    expect(() => verifyExecutionBundle(record, verifier)).toThrow(
      expect.objectContaining({ code: "SIGNATURE_INVALID" })
    );
  });

  it("content-addresses lineage into the signature: same content, different commit, one digest", () => {
    const first = signExecutionBundle(
      bundle({ changesetId: "cs-1", commitSha: "commit-a" }),
      signer
    );
    const second = signExecutionBundle(
      bundle({ changesetId: "cs-2", commitSha: "commit-b" }),
      signer
    );
    expect(second.digest).toBe(first.digest);
    expect(second.signature.value).not.toBe(first.signature.value);
    expect(verifyExecutionBundle(first, verifier).digest).toBe(first.digest);
    expect(verifyExecutionBundle(second, verifier).digest).toBe(second.digest);
  });

  it("detects a tampered signature", () => {
    const record = signExecutionBundle(bundle(), signer);
    const forged = { ...record, signature: { keyId: "k1", value: "not-a-signature" } };
    expect(() => verifyExecutionBundle(forged, verifier)).toThrow(
      expect.objectContaining({ code: "SIGNATURE_INVALID" })
    );
  });

  it("rejects a bundle signed by an unauthorized key", () => {
    const wrongKey = testKey("k1");
    const wrongVerifier = createEd25519BundleVerifier([wrongKey]);
    const record = signExecutionBundle(bundle(), signer);
    const error = (() => {
      try {
        verifyExecutionBundle(record, wrongVerifier);
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(BundleError);
    expect((error as BundleError).code).toBe("SIGNATURE_INVALID");
  });

  it("rejects a signature from an unknown keyId", () => {
    const otherKey = testKey("k2");
    const record = signExecutionBundle(bundle(), signerFor(otherKey));
    expect(() => verifyExecutionBundle(record, verifier)).toThrow(
      expect.objectContaining({ code: "SIGNATURE_KEY_UNKNOWN" })
    );
  });

  it("verifies old and new keys during rotation", () => {
    const oldKey = testKey("old");
    const newKey = testKey("new");
    const oldRecord = signExecutionBundle(bundle(), signerFor(oldKey));
    const newRecord = signExecutionBundle(bundle(), signerFor(newKey));
    const rotatedVerifier = createEd25519BundleVerifier([oldKey, newKey]);

    expect(verifyExecutionBundle(oldRecord, rotatedVerifier).digest).toBe(oldRecord.digest);
    expect(verifyExecutionBundle(newRecord, rotatedVerifier).digest).toBe(newRecord.digest);
  });

  it("rejects a bundle from another schema generation", () => {
    const legacyBundle = { ...bundle(), bundleVersion: 1 } as unknown as ExecutionBundle;
    const record = signExecutionBundle(legacyBundle, signer);
    expect(() => verifyExecutionBundle(record, verifier)).toThrow(
      expect.objectContaining({ code: "BUNDLE_VERSION_UNSUPPORTED" })
    );
  });

  it("binds the bundle identity, not only the definitions", () => {
    const record = signExecutionBundle(bundle(), signer);
    const rebranded = {
      ...record,
      bundle: { ...record.bundle, businessId: "biz-2" },
    };
    expect(() => verifyExecutionBundle(rebranded, verifier)).toThrow(
      expect.objectContaining({ code: "DIGEST_MISMATCH" })
    );
  });

  it("carries no secret material in the signing payload", () => {
    const record = signExecutionBundle(bundle(), signer);
    expect(JSON.stringify(record)).not.toContain(key.privateKeyPem);
  });

  it("offers a transition adapter only for public-key signers", () => {
    const record = signExecutionBundle(bundle(), signer);
    expect(verifyExecutionBundle(record, verifierFromSigner(signer)).digest).toBe(record.digest);
  });
});
