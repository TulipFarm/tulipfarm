import { describe, expect, it } from "vitest";
import {
  buildCommitMessage,
  buildCommitSigningPayload,
  type CommitSigner,
  CommitSigningError,
  createHmacCommitSigner,
  type SignedCommitMetadata,
  verifyCommitSignature,
} from "./commit-signing";

const META: SignedCommitMetadata = {
  changesetId: "cs_1",
  businessId: "biz_1",
  source: "agent",
  actor: { principalId: "prin_1", name: "Ada", email: "ada@example.com" },
  approval: { approvalId: "ap_1", approverId: "prin_2", decisionAt: "2026-07-22T00:00:00.000Z" },
  schemas: [
    { kind: "Routine", apiVersion: "v1" },
    { kind: "Agent", apiVersion: "v1" },
  ],
};

describe("buildCommitSigningPayload", () => {
  it("is deterministic regardless of schema ordering", () => {
    const reordered: SignedCommitMetadata = {
      ...META,
      schemas: [
        { kind: "Agent", apiVersion: "v1" },
        { kind: "Routine", apiVersion: "v1" },
      ],
    };
    expect(buildCommitSigningPayload("tree1", "base1", META)).toBe(
      buildCommitSigningPayload("tree1", "base1", reordered)
    );
  });

  it("changes when the tree, actor, or approval changes", () => {
    const base = buildCommitSigningPayload("tree1", "base1", META);
    expect(buildCommitSigningPayload("tree2", "base1", META)).not.toBe(base);
    expect(
      buildCommitSigningPayload("tree1", "base1", {
        ...META,
        actor: { ...META.actor, principalId: "prin_other" },
      })
    ).not.toBe(base);
    expect(buildCommitSigningPayload("tree1", "base1", { ...META, approval: undefined })).not.toBe(
      base
    );
  });

  it("encodes a null parent for an initial commit", () => {
    expect(buildCommitSigningPayload("tree1", null, META)).toContain('"parent":null');
  });
});

describe("createHmacCommitSigner", () => {
  it("signs deterministically and verifies", () => {
    const signer = createHmacCommitSigner("key-1", "secret");
    const payload = buildCommitSigningPayload("tree1", "base1", META);
    const signature = signer.sign(payload);
    expect(signer.sign(payload)).toBe(signature);
    expect(verifyCommitSignature(signer, payload, signature)).toBe(true);
  });

  it("rejects a tampered payload or signature", () => {
    const signer = createHmacCommitSigner("key-1", "secret");
    const payload = buildCommitSigningPayload("tree1", "base1", META);
    const signature = signer.sign(payload);
    expect(verifyCommitSignature(signer, `${payload} `, signature)).toBe(false);
    expect(verifyCommitSignature(signer, payload, `${signature}00`)).toBe(false);
  });

  it("throws on empty key material", () => {
    expect(() => createHmacCommitSigner("", "secret")).toThrow(CommitSigningError);
    expect(() => createHmacCommitSigner("key-1", "")).toThrow(CommitSigningError);
  });
});

describe("buildCommitMessage", () => {
  const signer: CommitSigner = { keyId: "key-1", sign: () => "deadbeef" };

  it("emits deterministic metadata trailers ending with the signature", () => {
    const message = buildCommitMessage("soul: update", META, {
      keyId: signer.keyId,
      value: "deadbeef",
    });
    const lines = message.trimEnd().split("\n");
    expect(lines[0]).toBe("soul: update");
    expect(message).toContain("Soul-Changeset: cs_1");
    expect(message).toContain("Soul-Principal: prin_1");
    expect(message).toContain("Soul-Approval: ap_1");
    expect(message).toContain("Soul-Approver: prin_2");
    expect(message).toContain("Soul-Schema: Agent@v1");
    expect(message).toContain("Soul-Schema: Routine@v1");
    expect(lines.at(-1)).toBe("Soul-Signature: key-1:deadbeef");
  });

  it("omits approval trailers when no approval was required", () => {
    const message = buildCommitMessage(
      "soul: update",
      { ...META, approval: undefined },
      {
        keyId: "key-1",
        value: "deadbeef",
      }
    );
    expect(message).not.toContain("Soul-Approval");
    expect(message).not.toContain("Soul-Approver");
  });
});
