import { describe, expect, it } from "vitest";
import { runRoutineHook } from "./isolate";

const SOURCE = `({
  run(ctx) {
    return { id: ctx.uuid(), next: ctx.uuid(), roll: Math.random() };
  }
})`;

function call(determinismSeed?: string) {
  return runRoutineHook({
    id: 1,
    kind: "routine-hook",
    hookSource: SOURCE,
    fnName: "run",
    invocation: {},
    ...(determinismSeed === undefined ? {} : { determinismSeed }),
  });
}

describe("routine hook determinism", () => {
  it("repeats its uuids and randoms across attempts of the same occurrence", async () => {
    const first = await call("run-1:fetch-stars");
    const second = await call("run-1:fetch-stars");

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect((second as { value: unknown }).value).toEqual((first as { value: unknown }).value);
  });

  it("gives a different occurrence a different stream", async () => {
    const a = await call("run-1:fetch-stars");
    const b = await call("run-2:fetch-stars");

    expect((b as { value: unknown }).value).not.toEqual((a as { value: unknown }).value);
  });

  it("still mints v4-shaped, non-repeating uuids within one invocation", async () => {
    const res = (await call("run-1:fetch-stars")) as { value: { id: string; next: string } };

    expect(res.value.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(res.value.next).not.toBe(res.value.id);
  });

  it("stays random when no seed is pinned", async () => {
    const first = (await call()) as { value: { id: string } };
    const second = (await call()) as { value: { id: string } };

    expect(second.value.id).not.toBe(first.value.id);
  });
});
