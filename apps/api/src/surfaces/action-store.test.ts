import { type TSchema, Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { MemorySurfaceActionStore } from "./action-store";

describe("MemorySurfaceActionStore", () => {
  it("enforces audience, expiry, Guardrail revision, input, and replay", async () => {
    const store = new MemorySurfaceActionStore();
    const created = await store.create({
      artifactId: "approval",
      revision: 1,
      action: { event: "record.approve" },
      inputSchema: Type.Object({ confirmed: Type.Boolean() }),
      audience: ["user:1"],
      target: { channel: "web", surface: "chat" },
      destination: "conversation:1",
      conversationId: "conversation:1",
      runId: null,
      waitId: null,
      guardrailRevision: "g1",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    const handles = await store.listForArtifact("approval", 1, "user:1");
    expect(Object.values(handles)).toEqual([created.handle]);
    await expect(
      store.resolve({
        handle: created.handle,
        principal: "user:2",
        value: { confirmed: true },
        currentGuardrailRevision: "g1",
        stepUpSatisfied: true,
        now: new Date("2029-01-01T00:00:00.000Z"),
      })
    ).resolves.toEqual({ ok: false, code: "wrong_principal" });
    await expect(
      store.resolve({
        handle: created.handle,
        principal: "user:1",
        value: { confirmed: true },
        currentGuardrailRevision: "g1",
        stepUpSatisfied: true,
        now: new Date("2029-01-01T00:00:00.000Z"),
      })
    ).resolves.toMatchObject({ ok: true });
    await expect(
      store.resolve({
        handle: created.handle,
        principal: "user:1",
        value: { confirmed: true },
        currentGuardrailRevision: "g1",
        stepUpSatisfied: true,
        now: new Date("2029-01-01T00:00:01.000Z"),
      })
    ).resolves.toEqual({ ok: false, code: "replayed" });
  });

  it("validates a persisted JSON Schema after TypeBox metadata has been serialized away", async () => {
    const store = new MemorySurfaceActionStore();
    const inputSchema = JSON.parse(
      JSON.stringify(
        Type.Object(
          {
            value: Type.Union([
              Type.Literal("coffee_aroma"),
              Type.Literal("bangalore_city"),
              Type.Literal("morning_sunrise"),
            ]),
          },
          { additionalProperties: false }
        )
      )
    ) as TSchema;

    const valid = await store.create({
      artifactId: "preference",
      revision: 1,
      action: { event: "preference.selected" },
      inputSchema,
      audience: ["user:1"],
      target: { channel: "web", surface: "chat" },
      destination: "conversation:1",
      conversationId: "conversation:1",
      runId: null,
      waitId: null,
      guardrailRevision: "g1",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });

    await expect(
      store.resolve({
        handle: valid.handle,
        principal: "user:1",
        value: { value: "bangalore_city" },
        currentGuardrailRevision: "g1",
        stepUpSatisfied: true,
        now: new Date("2029-01-01T00:00:00.000Z"),
      })
    ).resolves.toMatchObject({ ok: true });

    const invalid = await store.create({
      artifactId: "preference",
      revision: 2,
      action: { event: "preference.selected" },
      inputSchema,
      audience: ["user:1"],
      target: { channel: "web", surface: "chat" },
      destination: "conversation:1",
      conversationId: "conversation:1",
      runId: null,
      waitId: null,
      guardrailRevision: "g1",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });

    await expect(
      store.resolve({
        handle: invalid.handle,
        principal: "user:1",
        value: { value: "unknown" },
        currentGuardrailRevision: "g1",
        stepUpSatisfied: true,
        now: new Date("2029-01-01T00:00:00.000Z"),
      })
    ).resolves.toEqual({ ok: false, code: "invalid_input" });
  });
});
