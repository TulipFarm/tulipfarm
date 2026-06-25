import { describe, expect, it } from "vitest";
import { filterSlashItems, SLASH_ITEMS } from "./slash-items";

describe("filterSlashItems", () => {
  it("empty query returns the whole catalog", () => {
    expect(filterSlashItems("")).toHaveLength(SLASH_ITEMS.length);
  });

  it("matches by title prefix", () => {
    expect(filterSlashItems("head").map((i) => i.id)).toEqual(["h1", "h2", "h3"]);
  });

  it("matches by keyword (todo → task list)", () => {
    expect(filterSlashItems("todo").map((i) => i.id)).toContain("task");
  });

  it("surfaces callout kinds", () => {
    const ids = filterSlashItems("callout").map((i) => i.id);
    expect(ids).toContain("callout-warning");
    expect(ids).toContain("callout-note");
  });

  it("is case-insensitive", () => {
    expect(filterSlashItems("TABLE").map((i) => i.id)).toContain("table");
  });

  it("no match → empty", () => {
    expect(filterSlashItems("zzzzz")).toHaveLength(0);
  });

  it("every item has a unique id", () => {
    const ids = SLASH_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
