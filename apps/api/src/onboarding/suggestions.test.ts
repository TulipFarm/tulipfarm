import type { SoulLoader } from "@tulipfarm/soul";
import { describe, expect, it } from "vitest";
import { CATALOG } from "./catalog";
import { deriveSuggestions } from "./suggestions";

/** Minimal SoulLoader slice: deriveSuggestions only reads `.resources`. */
function soul(resourceNames: string[]): Pick<SoulLoader, "resources"> {
  const resources = new Map(resourceNames.map((n) => [n, {} as never]));
  return { resources } as Pick<SoulLoader, "resources">;
}

describe("deriveSuggestions", () => {
  it("returns the full catalog when the soul has no resources (empty soul)", () => {
    const out = deriveSuggestions(soul([]));
    expect(out).toHaveLength(CATALOG.length);
    expect(out.map((s) => s.id)).toEqual(CATALOG.map((e) => e.id));
  });

  it("hides an entry whose resource already exists", () => {
    const out = deriveSuggestions(soul(["tickets"]));
    expect(out.map((s) => s.id)).not.toContain("tickets");
    expect(out).toHaveLength(CATALOG.length - 1);
  });

  it("keeps entries whose resources are absent", () => {
    const out = deriveSuggestions(soul(["tickets"]));
    expect(out.map((s) => s.id)).toContain("leads");
    expect(out.map((s) => s.id)).toContain("projects");
  });

  it("hides multiple entries when several matching resources exist", () => {
    const out = deriveSuggestions(soul(["tickets", "leads", "invoices"]));
    const ids = out.map((s) => s.id);
    expect(ids).not.toContain("tickets");
    expect(ids).not.toContain("leads");
    expect(ids).not.toContain("invoices");
    expect(out).toHaveLength(CATALOG.length - 3);
  });

  it("projects to { id, label, prompt } and omits the resources match key", () => {
    const [first] = deriveSuggestions(soul([]));
    expect(Object.keys(first).sort()).toEqual(["id", "label", "prompt"]);
    expect(first).not.toHaveProperty("resources");
  });
});
