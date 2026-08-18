import { describe, expect, it } from "vitest";
import { resolveBindings } from "./bindings.ts";

describe("resolveBindings", () => {
  it("falls back to the free scripted tier when no model was named", () => {
    const bindings = resolveBindings(undefined);

    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.id).toBe("scripted");
  });

  it("resolves a single pinned model", () => {
    const bindings = resolveBindings("sonnet");

    expect(bindings.map((b) => b.id)).toEqual(["sonnet"]);
  });

  it("resolves a comma-separated matrix in the order it was written", () => {
    const bindings = resolveBindings("terra,sonnet");

    expect(bindings.map((b) => b.id)).toEqual(["terra", "sonnet"]);
  });

  it("tolerates spacing around the separators", () => {
    const bindings = resolveBindings(" sonnet , terra ");

    expect(bindings.map((b) => b.id)).toEqual(["sonnet", "terra"]);
  });

  it("refuses the same model twice, which would spend quota to compare it with itself", () => {
    expect(() => resolveBindings("sonnet,sonnet")).toThrow(/twice/);
  });

  it("refuses a model this repo has not pinned", () => {
    expect(() => resolveBindings("sonnet,gpt-4")).toThrow(/unknown model "gpt-4"/);
  });

  it("refuses an argument that names nothing", () => {
    expect(() => resolveBindings(",  ,")).toThrow(/at least one name/);
  });
});
