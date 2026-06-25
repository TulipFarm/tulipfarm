import { describe, expect, it } from "vitest";
import { buildConceptResolver, conceptHref, conceptSlug } from "./concept-href";
import type { BundlePageRef } from "./knowledge-api";

describe("conceptSlug", () => {
  it("takes the last path segment, lowercased + hyphenated", () => {
    expect(conceptSlug("oncall/infra")).toBe("infra");
    expect(conceptSlug("/tables/Orders.md")).toBe("orders");
    expect(conceptSlug("Q3 Forecast!")).toBe("q3-forecast");
    expect(conceptSlug("")).toBe("");
    expect(conceptSlug(null)).toBe("");
  });
});

describe("conceptHref", () => {
  it("builds /knowledge/concepts/<id>/<slug>, omitting an empty slug", () => {
    expect(conceptHref("id1", "oncall/infra")).toBe("/knowledge/concepts/id1/infra");
    expect(conceptHref("id1", "")).toBe("/knowledge/concepts/id1");
    expect(conceptHref("id1")).toBe("/knowledge/concepts/id1");
  });
});

describe("buildConceptResolver", () => {
  const pages: BundlePageRef[] = [
    {
      documentId: "d1",
      bundleId: "b1",
      bundleName: "Engineering",
      path: "oncall/infra",
      title: "Infra",
    },
    { documentId: "d2", bundleId: "b2", bundleName: "Sales", path: "pricing", title: "Pricing" },
  ];
  const r = buildConceptResolver(pages);

  it("resolves a same-space (bundleId, path) reference", () => {
    expect(r.byBundleIdPath("b1", "oncall/infra")?.documentId).toBe("d1");
    expect(r.byBundleIdPath("b1", "/oncall/infra.md")?.documentId).toBe("d1"); // normalized
    expect(r.byBundleIdPath("b1", "missing")).toBeNull();
  });

  it("resolves a cross-space (bundleName, path) reference", () => {
    expect(r.byBundleNamePath("Sales", "pricing")?.documentId).toBe("d2");
    expect(r.byBundleNamePath("Unknown", "pricing")).toBeNull();
  });

  it("resolves a document id back to its ref", () => {
    expect(r.byId("d2")?.path).toBe("pricing");
    expect(r.byId("nope")).toBeNull();
  });
});
