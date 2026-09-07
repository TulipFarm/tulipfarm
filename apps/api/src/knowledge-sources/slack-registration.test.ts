import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Slack Knowledge registration", () => {
  it("does not register automatic Slack history indexing", () => {
    const source = readFileSync(join(__dirname, "..", "index.ts"), "utf8");

    expect(source).not.toContain("registerSlackKnowledgeSync");
    expect(source).not.toContain("SLACK_KNOWLEDGE_SYNC_QUEUE");
  });
});
