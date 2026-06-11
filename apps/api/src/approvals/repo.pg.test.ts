import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { ApprovalsRepo } from "./repo";

describe("ApprovalsRepo (PGlite)", () => {
  let db: PGlite;
  let repo: ApprovalsRepo;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
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
    });

    await repo.settle(id, "denied");
    const row = await repo.findById(id);
    expect(row?.status).toBe("denied");
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
    });

    const row = await repo.findById(id);
    expect(row?.payload).toEqual(payload);
  });
});
