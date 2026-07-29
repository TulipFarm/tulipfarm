import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { SurfaceInteractionSchema } from "./contracts";

const interaction = {
  id: "interaction-1",
  artifactId: "artifact-1",
  revision: 1,
  event: "preference.selected",
  input: { value: "bangalore_city" },
  principal: "user:1",
  target: { channel: "web", surface: "chat" },
  destination: "conversation:1",
  occurredAt: "2026-07-28T15:02:30.252Z",
} as const;

describe("SurfaceInteractionSchema", () => {
  it("accepts normalized ISO-8601 timestamps with TypeBox runtime validation", () => {
    expect(Value.Check(SurfaceInteractionSchema, interaction)).toBe(true);
  });

  it("rejects non-date interaction timestamps", () => {
    expect(
      Value.Check(SurfaceInteractionSchema, {
        ...interaction,
        occurredAt: "yesterday",
      })
    ).toBe(false);
  });
});
