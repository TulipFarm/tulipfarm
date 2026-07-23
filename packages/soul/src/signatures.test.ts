import type { VersionedSchemaDocument } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { BundleError, type ExecutionBundle } from "./bundle";
import { compileExecutionBundle } from "./compiler";
import { createHmacBundleSigner, signExecutionBundle, verifyExecutionBundle } from "./signatures";

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

function bundle(): ExecutionBundle {
  return compileExecutionBundle({
    businessId: "biz-1",
    changesetId: "cs-1",
    commitSha: "c0ffee",
    documents: [agent("triage")],
  });
}

const signer = createHmacBundleSigner("k1", "s3cret");

describe("signExecutionBundle / verifyExecutionBundle", () => {
  it("opens a signed bundle for execution without any Git access", () => {
    const record = signExecutionBundle(bundle(), signer);
    const runtime = verifyExecutionBundle(record, signer);
    expect(runtime.digest).toBe(record.digest);
    expect(runtime.commitSha).toBe("c0ffee");
    expect(runtime.get("Agent", "triage")?.authoredVersion).toBe(2);
    expect(runtime.getById("id-triage")?.slug).toBe("triage");
    expect(runtime.get("Agent", "unknown")).toBeUndefined();
  });

  it("is deterministic: the same tree signs to the same digest and signature", () => {
    const first = signExecutionBundle(bundle(), signer);
    const second = signExecutionBundle(bundle(), signer);
    expect(second.digest).toBe(first.digest);
    expect(second.signature).toEqual(first.signature);
  });

  it("detects a tampered definition", () => {
    const record = signExecutionBundle(bundle(), signer);
    (record.bundle.definitions[0].document.spec as Record<string, unknown>).instructions = "exfil";
    expect(() => verifyExecutionBundle(record, signer)).toThrow(
      expect.objectContaining({ code: "DIGEST_MISMATCH" })
    );
  });

  it("detects a tampered signature", () => {
    const record = signExecutionBundle(bundle(), signer);
    const forged = { ...record, signature: { keyId: "k1", value: "0".repeat(64) } };
    expect(() => verifyExecutionBundle(forged, signer)).toThrow(
      expect.objectContaining({ code: "SIGNATURE_INVALID" })
    );
  });

  it("rejects a bundle signed by an unauthorized key", () => {
    const record = signExecutionBundle(bundle(), createHmacBundleSigner("k2", "other"));
    const error = (() => {
      try {
        verifyExecutionBundle(record, signer);
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(BundleError);
    expect((error as BundleError).code).toBe("SIGNATURE_INVALID");
  });

  it("binds the bundle identity, not only the definitions", () => {
    const record = signExecutionBundle(bundle(), signer);
    const rebranded = {
      ...record,
      bundle: { ...record.bundle, businessId: "biz-2" },
    };
    expect(() => verifyExecutionBundle(rebranded, signer)).toThrow(
      expect.objectContaining({ code: "DIGEST_MISMATCH" })
    );
  });

  it("carries no secret material in the signing payload", () => {
    const record = signExecutionBundle(bundle(), signer);
    expect(JSON.stringify(record)).not.toContain("s3cret");
  });
});
