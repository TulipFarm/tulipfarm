import { describe, expect, it } from "vitest";
import type { TimelinePart } from "~/lib/chat/types";
import {
  describeToolCall,
  describeToolResult,
  formatBytes,
  formatDuration,
  toolFamily,
  toolSubject,
  toolTierLabel,
} from "./tool-summary";

describe("toolFamily", () => {
  it("matches the real tool names the product registers", () => {
    expect(toolFamily("github_pull_request_read")).toBe("github");
    expect(toolFamily("github_issue_comment")).toBe("github");
    expect(toolFamily("send_slack_message")).toBe("slack");
    expect(toolFamily("kv_set")).toBe("storage");
    expect(toolFamily("update_memory")).toBe("memory");
    expect(toolFamily("memory_read")).toBe("memory");
    expect(toolFamily("search_docs")).toBe("knowledge");
    expect(toolFamily("read_page")).toBe("knowledge");
    expect(toolFamily("present")).toBe("surface");
    expect(toolFamily("get_current_time")).toBe("time");
    expect(toolFamily("call_skill")).toBe("delegation");
  });

  it("does not read a prefixed name as a bare suffix", () => {
    // `github_content_read` is a GitHub call, not a knowledge `read_page`.
    expect(toolFamily("github_content_read")).toBe("github");
  });

  it("falls back to a real family rather than throwing on an unknown tool", () => {
    expect(toolFamily("some_future_tool")).toBe("generic");
    expect(toolFamily("")).toBe("generic");
  });
});

describe("toolTierLabel", () => {
  it("prefers the tier the stream named", () => {
    expect(toolTierLabel("system", "github")).toBe("system");
  });

  it("infers a sensible tier when the stream named none", () => {
    expect(toolTierLabel(undefined, "github")).toBe("integration");
    expect(toolTierLabel(undefined, "slack")).toBe("integration");
    expect(toolTierLabel(undefined, "memory")).toBe("platform");
  });
});

describe("toolSubject", () => {
  it("picks the most specific scalar argument", () => {
    expect(toolSubject({ query: "pgvector migration", limit: 5 })).toBe('"pgvector migration"');
    expect(toolSubject({ repo: "maddhruv/tulipfarm", number: 412 })).toBe("maddhruv/tulipfarm#412");
  });

  it("quotes prose a person typed but leaves an identifier bare", () => {
    expect(toolSubject({ query: "refund policy" })).toBe('"refund policy"');
    expect(toolSubject({ key: "billing:tier" })).toBe("billing:tier");
    expect(toolSubject({ channel: "#billing" })).toBe("#billing");
  });

  it("carries the issue number a repo-scoped call names", () => {
    expect(toolSubject({ repo: "maddhruv/tulipfarm", issue: 412 })).toBe("maddhruv/tulipfarm#412");
    expect(toolSubject({ repo: "maddhruv/tulipfarm" })).toBe("maddhruv/tulipfarm");
    expect(toolSubject({ repo: "maddhruv/tulipfarm", issue: 0 })).toBe("maddhruv/tulipfarm");
  });

  it("accepts a numeric subject", () => {
    expect(toolSubject({ number: 412 })).toBe("412");
  });

  it("refuses a non-scalar subject rather than putting a payload fragment in a headline", () => {
    expect(toolSubject({ query: { nested: true } })).toBeUndefined();
    expect(toolSubject({ items: [1, 2, 3] })).toBeUndefined();
  });

  it("returns nothing for values that are not argument objects", () => {
    expect(toolSubject(null)).toBeUndefined();
    expect(toolSubject("string")).toBeUndefined();
    expect(toolSubject([1, 2])).toBeUndefined();
    expect(toolSubject({ unrelated: "x" })).toBeUndefined();
  });

  it("collapses whitespace and truncates a long subject", () => {
    expect(toolSubject({ query: "  a\n  b  " })).toBe('"a b"');
    const long = toolSubject({ query: "z".repeat(200) });
    expect(long?.endsWith('…"')).toBe(true);
    expect((long ?? "").length).toBeLessThanOrEqual(67);
  });
});

describe("describeToolCall", () => {
  it("prefers a server-written summary over anything derived", () => {
    expect(describeToolCall("search_docs", { query: "x" }, "Found 3 pages")).toBe("Found 3 pages");
  });

  it("ignores a blank server summary", () => {
    expect(describeToolCall("search_docs", { query: "pgvector" }, "   ")).toBe(
      'Searched docs "pgvector"'
    );
  });

  it("composes a verb and a real argument", () => {
    expect(describeToolCall("github_issue_comment", { repo: "maddhruv/tulipfarm" })).toBe(
      "Commented on maddhruv/tulipfarm"
    );
    expect(describeToolCall("kv_set", { key: "last_sync" })).toBe("Saved last_sync");
    expect(describeToolCall("github_repo_push", { repo: "a/b" })).toBe("Pushed to a/b");
  });

  it("degrades to the tool's own name when there is nothing to derive", () => {
    expect(describeToolCall("some_future_tool", {})).toBe("Some future tool");
    expect(describeToolCall("complete_state", undefined)).toBe("Completed step");
  });

  it("keeps an unmatched tool's arguments visible without inventing a verb", () => {
    expect(describeToolCall("some_future_tool", { name: "widget" })).toBe(
      "Some future tool · widget"
    );
  });

  it("reads a leading-verb tool in the past tense instead of as an imperative", () => {
    // The suffix table cannot match these, and humanizing them left "List resource types" sitting
    // next to past-tense rows in the same run.
    expect(describeToolCall("list_resource_types", {})).toBe("Listed resource types");
    expect(describeToolCall("create_knowledge_page", {})).toBe("Created knowledge page");
    expect(describeToolCall("create_space", { name: "Ops" })).toBe("Created space Ops");
  });

  it("names what a trailing-verb tool acted on rather than showing a bare verb", () => {
    // `agent_list` and `skill_list` both used to render as just "Listed", which made two different
    // calls in one run indistinguishable.
    expect(describeToolCall("agent_list", {})).toBe("Listed agents");
    expect(describeToolCall("skill_list", {})).toBe("Listed skills");
    expect(describeToolCall("github_pull_request_read", {})).toBe("Read github pull request");
    expect(describeToolCall("soul_repo_push", {})).toBe("Pushed to soul repo");
  });

  it("does not repeat the object once an argument names the subject", () => {
    // A phrasal verb wants one or the other: "Commented on github issue maddhruv/tulipfarm#412"
    // reads worse than either half alone.
    expect(
      describeToolCall("github_issue_comment", { repo: "maddhruv/tulipfarm", issue: 412 })
    ).toBe("Commented on maddhruv/tulipfarm#412");
  });

  it("lets an exact name beat the verb patterns it would otherwise match", () => {
    expect(describeToolCall("get_current_time", {})).toBe("Checked the time");
    expect(describeToolCall("send_slack_message", {})).toBe("Sent Slack message");
    expect(describeToolCall("search_docs", { query: "refund policy" })).toBe(
      'Searched docs "refund policy"'
    );
  });
});

describe("formatDuration", () => {
  it("keeps sub-second precision instead of rounding it away", () => {
    expect(formatDuration(412)).toBe("412ms");
    expect(formatDuration(0)).toBe("0ms");
  });

  it("switches to seconds and minutes as the call gets longer", () => {
    expect(formatDuration(1_240)).toBe("1.2s");
    expect(formatDuration(64_000)).toBe("1m 4s");
  });

  it("shows nothing rather than a fabricated number", () => {
    expect(formatDuration(undefined)).toBeUndefined();
    expect(formatDuration(-1)).toBeUndefined();
    expect(formatDuration(Number.NaN)).toBeUndefined();
  });
});

describe("formatBytes", () => {
  it("scales through B, kB and MB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2_048)).toBe("2.0 kB");
    expect(formatBytes(3 * 1_024 * 1_024)).toBe("3.0 MB");
  });

  it("shows nothing rather than a fabricated size", () => {
    expect(formatBytes(undefined)).toBeUndefined();
    expect(formatBytes(-5)).toBeUndefined();
  });
});

type ToolPart = Extract<TimelinePart, { kind: "tool" }>;

describe("describeToolResult", () => {
  function part(overrides: Partial<ToolPart>): ToolPart {
    return {
      kind: "tool",
      toolCallId: "c1",
      toolName: "search_docs",
      status: "done",
      ...overrides,
    } as ToolPart;
  }

  function preview(value: unknown): ToolPart {
    return part({
      resultPreview: { json: JSON.stringify(value), truncated: false },
    } as Partial<ToolPart>);
  }

  it("names the payload array rather than calling everything a result", () => {
    expect(describeToolResult(preview({ success: true, skills: [1, 2, 3] }))).toBe("3 skills");
    expect(describeToolResult(preview([1, 2]))).toBe("2 items");
  });

  it("reads an explicit count before guessing from array lengths", () => {
    expect(describeToolResult(preview({ total: 42, items: [1] }))).toBe("42 results");
  });

  it("unwraps an envelope to find the real payload", () => {
    expect(describeToolResult(preview({ data: { documents: [1, 2, 3, 4] } }))).toBe("4 documents");
  });

  it("singularises a count of one", () => {
    expect(describeToolResult(preview({ results: [{ id: "a" }] }))).toBe("1 result");
    expect(describeToolResult(preview({ count: 1 }))).toBe("1 result");
  });

  it("falls back to the live result when no preview was persisted", () => {
    expect(describeToolResult(part({ result: { files: [1, 2] } } as Partial<ToolPart>))).toBe(
      "2 files"
    );
  });

  it("says nothing rather than inventing a number", () => {
    expect(describeToolResult(preview({ success: true }))).toBeUndefined();
    expect(describeToolResult(preview("done"))).toBeUndefined();
    expect(describeToolResult(part({}))).toBeUndefined();
    expect(
      describeToolResult(
        part({ resultPreview: { json: "{not json", truncated: false } } as Partial<ToolPart>)
      )
    ).toBeUndefined();
  });
});
