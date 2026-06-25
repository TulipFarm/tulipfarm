import { describe, expect, it } from "vitest";
import { filterMentionSections, filterTagSuggestions, type MentionDataSource } from "./host-data";

function source(over: Partial<MentionDataSource> = {}): MentionDataSource {
  return {
    getPages: () => [
      { label: "Deploy Runbook", href: "runbook.md" },
      { label: "Rollback", href: "runbook/rollback.md" },
      { label: "Pricing", href: "tf:page/Sales/pricing", hint: "Sales" },
    ],
    getAgents: () => [{ label: "deploy-bot", href: "tf:agent/deploy-bot" }],
    getResources: () => [{ label: "tickets", href: "tf:resource/tickets" }],
    getTags: () => ["urgent", "runbook", "oncall"],
    ...over,
  };
}

describe("filterMentionSections", () => {
  it("returns all three sections for an empty query", () => {
    expect(filterMentionSections(source(), "").map((s) => s.title)).toEqual([
      "Pages",
      "Agents",
      "Resources",
    ]);
  });

  it("filters by label and drops empty sections", () => {
    const sections = filterMentionSections(source(), "run");
    expect(sections.map((s) => s.key)).toEqual(["pages"]);
    expect(sections[0]?.items.map((i) => i.label)).toEqual(["Deploy Runbook"]);
  });

  it("matches a page by its space hint", () => {
    const sections = filterMentionSections(source(), "sales");
    expect(sections[0]?.key).toBe("pages");
    expect(sections[0]?.items[0]?.label).toBe("Pricing");
  });

  it("ranks prefix matches before substring matches", () => {
    const src = source({
      getAgents: () => [
        { label: "deploy-bot", href: "tf:agent/deploy-bot" },
        { label: "bot-deployer", href: "tf:agent/bot-deployer" },
      ],
      getPages: () => [],
      getResources: () => [],
    });
    const agents = filterMentionSections(src, "deploy")[0];
    expect(agents?.items.map((i) => i.label)).toEqual(["deploy-bot", "bot-deployer"]);
  });
});

describe("filterTagSuggestions", () => {
  it("matches existing tags and offers a create entry for a new query", () => {
    expect(filterTagSuggestions(["urgent", "runbook"], "run")).toEqual({
      tags: ["runbook"],
      create: "run",
    });
  });

  it("omits the create entry when the query exactly matches an existing tag", () => {
    expect(filterTagSuggestions(["urgent"], "urgent")).toEqual({ tags: ["urgent"], create: null });
  });

  it("returns all tags with no create entry for an empty query", () => {
    expect(filterTagSuggestions(["a", "b"], "")).toEqual({ tags: ["a", "b"], create: null });
  });
});
