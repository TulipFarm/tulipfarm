import { textContent } from "@tulipfarm/schema";
import { describe, expect, it, vi } from "vitest";
import type { EvalCase } from "./case.ts";
import { corpusHash } from "./corpus.ts";

/**
 * A stand-in for the shipped declaration, so the description can move without editing the product.
 *
 * The property under test cannot be reached with two real Tools: naming a different Tool also
 * changes the Case object, which is hashed anyway, so such a test would pass with the declaration
 * left out of the hash entirely.
 */
const shipped = vi.hoisted(() => ({ description: "Write a document the person can open." }));

vi.mock("./platform-tools.ts", () => ({
  platformToolNames: () => ["file_create"],
  resolvePlatformTool: (name: string) =>
    name === "file_create"
      ? { name, description: shipped.description, inputSchema: {} }
      : undefined,
}));

const cases: readonly EvalCase[] = [
  {
    id: "a",
    tier: "l2",
    agent: "triage",
    context: { governancePages: [] },
    input: [{ role: "user", content: textContent("hello") }],
    platformTools: ["file_create"],
    expect: [{ kind: "loop_status", status: "completed" }],
  },
];

describe("the Corpus hash and a shipped Tool declaration", () => {
  it("moves when the declaration changes, even though no Case file did", () => {
    // A Case names the Tool; the declaration is what reaches the prompt. If only the name were
    // hashed, rewording `file_create` would change what every such Case measures while its
    // Baseline went on comparing new behaviour against old numbers.
    const before = corpusHash(cases, "soul-1");
    shipped.description = "Write a document the person can open, download and forward.";
    const after = corpusHash(cases, "soul-1");
    shipped.description = "Write a document the person can open.";
    expect(after).not.toBe(before);
  });

  it("is stable when nothing changed", () => {
    expect(corpusHash(cases, "soul-1")).toBe(corpusHash(cases, "soul-1"));
  });
});
