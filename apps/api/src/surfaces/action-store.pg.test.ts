import type { PGlite } from "@electric-sql/pglite";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Queryable } from "../db";
import { makeMigratedPglite } from "../test/pglite";
import { PgSurfaceActionStore } from "./action-store";

describe("PgSurfaceActionStore reservations", () => {
  let db: PGlite;
  let store: PgSurfaceActionStore;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    store = new PgSurfaceActionStore(db as unknown as Queryable);
  });

  afterEach(async () => {
    await db.close();
  });

  it("persists a value-free reservation and completes it only after follow-up work", async () => {
    const handle = await store.create({
      artifactId: "artifact-1",
      revision: 1,
      inputSchema: Type.Object({ email: Type.String() }),
      audience: ["user-1"],
      target: { channel: "slack", surface: "modal" },
      destination: "C-OPS",
      conversationId: null,
      runId: null,
      waitId: null,
      guardrailRevision: "guardrail-1",
      expiresAt: new Date("2027-01-01T00:00:00.000Z"),
      action: { event: "form.submit" },
    });
    const input = {
      handle: handle.handle,
      principal: "user-1",
      principalKind: "user",
      value: { email: "muskan@example.com" },
      currentGuardrailRevision: "guardrail-1",
      stepUpSatisfied: false,
      now: new Date("2026-09-07T10:00:00.000Z"),
    };

    const reserved = await store.reserve(input);
    expect(reserved).toMatchObject({ ok: true, outcome: "reserved" });
    if (!reserved.ok) throw new Error("reservation failed");

    const rows = await db.query<{
      consumed_at: Date | null;
      reserved_input_hash: string;
      persisted: string;
    }>(
      `SELECT consumed_at, reserved_input_hash, row_to_json(surface_actions)::text AS persisted
         FROM surface_actions
        WHERE handle = $1`,
      [handle.handle]
    );
    expect(rows.rows[0]?.consumed_at).toBeNull();
    expect(rows.rows[0]?.reserved_input_hash).not.toContain("muskan@example.com");
    expect(rows.rows[0]?.persisted).not.toContain("muskan@example.com");

    const replay = await new PgSurfaceActionStore(db as unknown as Queryable).reserve(input);
    expect(replay).toMatchObject({
      ok: true,
      outcome: "existing",
      interaction: { id: reserved.interaction.id },
    });
    await expect(store.findReservation(reserved.interaction.id)).resolves.toMatchObject({
      interactionId: reserved.interaction.id,
      principal: "user-1",
      principalKind: "user",
    });
    await expect(store.listPending(new Date("2026-09-07T10:00:01.000Z"), 10)).resolves.toHaveLength(
      1
    );

    await expect(
      store.complete({ handle: handle.handle, interactionId: reserved.interaction.id })
    ).resolves.toBe("consumed");
    await expect(store.reserve(input)).resolves.toMatchObject({
      ok: true,
      outcome: "completed",
      interaction: { id: reserved.interaction.id },
    });
  });
});
