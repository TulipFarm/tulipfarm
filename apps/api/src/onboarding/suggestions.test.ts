import { ONBOARDING_FALLBACK } from "@tulipfarm/built-in-agents";
import type { SoulLoader } from "@tulipfarm/soul";
import { describe, expect, it } from "vitest";
import { deriveSuggestions } from "./suggestions";

/** Minimal SoulLoader slice: deriveSuggestions only reads `.resources`. */
function soul(resourceNames: string[]): Pick<SoulLoader, "resources"> {
  const resources = new Map(resourceNames.map((n) => [n, {} as never]));
  return { resources } as Pick<SoulLoader, "resources">;
}

describe("deriveSuggestions", () => {
  it("returns the full fallback catalog unconditionally", () => {
    const out = deriveSuggestions(soul(["ticket"]));
    expect(out).toHaveLength(ONBOARDING_FALLBACK.length);
    expect(out.map((s) => s.id)).toEqual(ONBOARDING_FALLBACK.map((e) => e.id));
  });

  it("projects to { id, label, prompt } and has expected shape", () => {
    const [first] = deriveSuggestions(soul([]));
    expect(Object.keys(first).sort()).toEqual(["id", "label", "prompt"]);
  });
});
