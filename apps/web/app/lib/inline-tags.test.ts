import { describe, expect, it } from "vitest";
import { extractInlineTags, mergeTags } from "./inline-tags";

describe("extractInlineTags", () => {
  it("captures #tag tokens, lowercases + dedupes, and ignores headings", () => {
    const body = "# Heading not a tag\n\nSee #Urgent and #runbook. Repeat #urgent.\n(#oncall) too.";
    expect(extractInlineTags(body)).toEqual(["urgent", "runbook", "oncall"]);
  });

  it("ignores hashes inside fenced and inline code", () => {
    const body = "Real #deploy.\n\n```c\n#include <stdio.h>\n```\n\nInline `#nope` here.";
    expect(extractInlineTags(body)).toEqual(["deploy"]);
  });

  it("returns [] when there are no inline tags", () => {
    expect(extractInlineTags("# Title\n\nplain text")).toEqual([]);
  });

  it("ignores numeric refs (tags must start with a letter)", () => {
    expect(extractInlineTags("fixed in #123 and #v2, not #1 or #42")).toEqual(["v2"]);
  });
});

describe("mergeTags", () => {
  it("unions frontmatter tags with body tags, frontmatter first, deduped", () => {
    expect(mergeTags(["sales"], "see #urgent and #sales")).toEqual(["sales", "urgent"]);
  });

  it("lowercases all tags (frontmatter + body) for consistent filtering", () => {
    expect(mergeTags(["Sales", "URGENT"], "also #Deploy")).toEqual(["sales", "urgent", "deploy"]);
  });
});
