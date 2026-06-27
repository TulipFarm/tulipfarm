import { describe, expect, it } from "vitest";
import type { SpacePageRef } from "./knowledge-api";
import { buildPageResolver, pageHref, pageSlug } from "./page-href";

describe("pageSlug", () => {
  it("takes the last path segment, lowercased + hyphenated", () => {
    expect(pageSlug("oncall/infra")).toBe("infra");
    expect(pageSlug("/tables/Orders.md")).toBe("orders");
    expect(pageSlug("Q3 Forecast!")).toBe("q3-forecast");
    expect(pageSlug("")).toBe("");
    expect(pageSlug(null)).toBe("");
  });
});

describe("pageHref", () => {
  it("builds /knowledge/pages/<id>/<slug>, omitting an empty slug", () => {
    expect(pageHref("id1", "oncall/infra")).toBe("/knowledge/pages/id1/infra");
    expect(pageHref("id1", "")).toBe("/knowledge/pages/id1");
    expect(pageHref("id1")).toBe("/knowledge/pages/id1");
  });
});

describe("buildPageResolver", () => {
  const pages: SpacePageRef[] = [
    {
      pageId: "d1",
      spaceId: "b1",
      spaceName: "Engineering",
      path: "oncall/infra",
      title: "Infra",
    },
    { pageId: "d2", spaceId: "b2", spaceName: "Sales", path: "pricing", title: "Pricing" },
  ];
  const r = buildPageResolver(pages);

  it("resolves a same-space (spaceId, path) reference", () => {
    expect(r.bySpaceIdPath("b1", "oncall/infra")?.pageId).toBe("d1");
    expect(r.bySpaceIdPath("b1", "/oncall/infra.md")?.pageId).toBe("d1"); // normalized
    expect(r.bySpaceIdPath("b1", "missing")).toBeNull();
  });

  it("resolves a cross-space (spaceName, path) reference", () => {
    expect(r.bySpaceNamePath("Sales", "pricing")?.pageId).toBe("d2");
    expect(r.bySpaceNamePath("Unknown", "pricing")).toBeNull();
  });

  it("resolves a page id back to its ref", () => {
    expect(r.byId("d2")?.path).toBe("pricing");
    expect(r.byId("nope")).toBeNull();
  });
});
