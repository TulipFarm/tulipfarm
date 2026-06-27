import { describe, expect, it } from "vitest";
import { BLOCK_CHAR_CAP, buildGovernanceBlock, PER_DOC_CHAR_CAP } from "./governance";
import type { KnowledgePage } from "./types";

function govPage(over: Partial<KnowledgePage>): KnowledgePage {
  const now = new Date();
  return {
    _id: "x",
    title: "Policy",
    content: "",
    plainText: "body",
    source: "authored",
    sourceId: "x",
    domain: null,
    tags: [],
    active: true,
    alwaysLoadForAgents: true,
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe("buildGovernanceBlock", () => {
  it("returns empty string when nothing qualifies", () => {
    expect(buildGovernanceBlock([])).toBe("");
  });

  it("wraps pages in a governance-knowledge block with titles", () => {
    const block = buildGovernanceBlock([
      govPage({ title: "Code of Conduct", plainText: "be nice" }),
    ]);
    expect(block).toContain("<governance-knowledge>");
    expect(block).toContain("## Code of Conduct");
    expect(block).toContain("be nice");
    expect(block).toContain("</governance-knowledge>");
  });

  it("skips a page whose body exceeds the per-page cap (not truncated)", () => {
    const big = "x".repeat(PER_DOC_CHAR_CAP + 1);
    const block = buildGovernanceBlock([
      govPage({ title: "Big", plainText: big }),
      govPage({ title: "Small", plainText: "ok" }),
    ]);
    expect(block).not.toContain("Big");
    expect(block).toContain("Small");
  });

  it("stops adding pages once the block cap would be exceeded", () => {
    const body = "y".repeat(PER_DOC_CHAR_CAP);
    const pages = Array.from({ length: 10 }, (_, i) =>
      govPage({ title: `D${i}`, plainText: body })
    );
    const block = buildGovernanceBlock(pages);
    const count = (block.match(/## D/g) ?? []).length;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(10);
    expect(block.length).toBeLessThanOrEqual(BLOCK_CHAR_CAP + 60);
  });

  it("orders domain-scoped before tenant-wide and excludes other domains", () => {
    const block = buildGovernanceBlock(
      [
        govPage({ title: "Tenant", plainText: "t", domain: null }),
        govPage({ title: "Ops", plainText: "o", domain: "ops" }),
        govPage({ title: "HR", plainText: "h", domain: "hr" }),
      ],
      "ops"
    );
    expect(block).toContain("Ops");
    expect(block).toContain("Tenant");
    expect(block).not.toContain("HR");
    expect(block.indexOf("Ops")).toBeLessThan(block.indexOf("Tenant"));
  });
});
