import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { type ApprovalGuardrailEvidence, ApprovalsRepo } from "@tulipfarm/tool-host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";

/** Every `tool_call` row carries the Guardrail evidence that demanded it; the table requires it. */
const EVIDENCE: ApprovalGuardrailEvidence = {
  demandedBy: "guardrail_rule",
  guardrailRevision: "gr-1",
  reason: "approval_required",
  ruleId: "rule-1",
  toolName: "write_x",
  intentDigest: "sha256:intent",
  demandedAt: "2026-08-16T00:00:00.000Z",
};

describe("ApprovalsRepo (PGlite)", () => {
  let db: PGlite;
  let repo: ApprovalsRepo;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    repo = new ApprovalsRepo(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("inserts a pending row and findById returns it", async () => {
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 300_000);
    await repo.insert({
      id,
      kind: "tool_call",
      payload: { toolName: "write_x", args: { a: 1 } },
      expiresAt,
      requesterPrincipalId: "user:requester-1",
      evidence: EVIDENCE,
    });

    const row = await repo.findById(id);
    expect(row).not.toBeNull();
    expect(row?.id).toBe(id);
    expect(row?.kind).toBe("tool_call");
    expect(row?.status).toBe("pending");
    expect(row?.resolvedAt).toBeNull();
  });

  it("settle updates status and resolved_at", async () => {
    const id = randomUUID();
    await repo.insert({
      id,
      kind: "tool_call",
      payload: {},
      expiresAt: new Date(Date.now() + 300_000),
      requesterPrincipalId: "user:requester-1",
      evidence: EVIDENCE,
    });

    await repo.settle(id, "approved");

    const row = await repo.findById(id);
    expect(row?.status).toBe("approved");
    expect(row?.resolvedAt).not.toBeNull();
  });

  it("settle with denied sets status denied", async () => {
    const id = randomUUID();
    await repo.insert({
      id,
      kind: "tool_call",
      payload: {},
      expiresAt: new Date(Date.now() + 300_000),
      requesterPrincipalId: "user:requester-1",
      evidence: EVIDENCE,
    });

    await repo.settle(id, "denied");
    const row = await repo.findById(id);
    expect(row?.status).toBe("denied");
  });

  it("settlePending is atomic and rejects replay", async () => {
    const id = randomUUID();
    await repo.insert({
      id,
      kind: "tool_call",
      payload: {},
      expiresAt: new Date(Date.now() + 300_000),
      requesterPrincipalId: "user:requester-1",
      evidence: EVIDENCE,
    });

    expect(await repo.settlePending(id, "approved")).toBe(true);
    expect(await repo.settlePending(id, "denied")).toBe(false);
    expect((await repo.findById(id))?.status).toBe("approved");
  });

  it("findById returns null for unknown id", async () => {
    expect(await repo.findById(randomUUID())).toBeNull();
  });

  it("preserves jsonb payload round-trip", async () => {
    const id = randomUUID();
    const payload = { toolCallId: "tc-1", toolName: "send_email", args: { to: "a@b.com" } };
    await repo.insert({
      id,
      kind: "tool_call",
      payload,
      expiresAt: new Date(Date.now() + 300_000),
      requesterPrincipalId: "user:requester-1",
      evidence: EVIDENCE,
    });

    const row = await repo.findById(id);
    expect(row?.payload).toEqual(payload);
  });
});
