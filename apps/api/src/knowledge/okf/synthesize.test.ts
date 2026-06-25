import { describe, expect, it } from "vitest";
import { directChildren, type IndexEntry, renderIndex } from "./synthesize";

const entries: IndexEntry[] = [
  { path: "overview", title: "Overview", description: "Top-level." },
  { path: "tables/orders", title: "Orders", description: "One row per order." },
  { path: "tables/customers", title: "Customers", description: null },
  { path: "tables/legacy/old", title: "Old", description: null },
  { path: "playbooks/incident", title: "Incident", description: "Triage." },
];

describe("directChildren", () => {
  it("splits root into direct concepts + immediate subdirs", () => {
    const { concepts, subdirs } = directChildren("", entries);
    expect(concepts.map((c) => c.path)).toEqual(["overview"]);
    expect(subdirs).toEqual(["playbooks", "tables"]);
  });

  it("scopes to a nested directory", () => {
    const { concepts, subdirs } = directChildren("tables", entries);
    expect(concepts.map((c) => c.path)).toEqual(["tables/customers", "tables/orders"]);
    expect(subdirs).toEqual(["legacy"]);
  });
});

describe("renderIndex", () => {
  it("renders subdirs and concepts with descriptions", () => {
    const md = renderIndex("tables", entries);
    expect(md).toContain("# Subdirectories");
    expect(md).toContain("* [legacy](legacy/)");
    expect(md).toContain("# Concepts");
    expect(md).toContain("* [Orders](orders.md) - One row per order.");
    expect(md).toContain("* [Customers](customers.md)");
    expect(md).not.toContain("Customers](customers.md) -"); // null description => no trailing dash
  });
});
