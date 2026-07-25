import { describe, expect, it } from "vitest";
import { assembleContext, ContextAssemblyError, type ContextCandidate } from "./manifest";
import { INSTRUCTION_PRECEDENCE } from "./precedence";

function candidate(overrides: Partial<ContextCandidate> = {}): ContextCandidate {
  return {
    sourceId: "message-1",
    kind: "message",
    precedence: "user_request",
    version: "1",
    classification: "internal",
    taint: "trusted",
    authorization: { decision: "allow" },
    tokens: 10,
    digest: "sha256:message-1",
    ...overrides,
  };
}

const base = {
  businessId: "biz-1",
  runId: "run-1",
  stateId: "state-1",
  guardrailDigest: "sha256:guardrail",
  bundleDigest: "sha256:bundle",
  budgetTokens: 1_000,
};

describe("assembleContext", () => {
  it("orders entries by the fixed instruction precedence, not by input order", () => {
    const manifest = assembleContext({
      ...base,
      candidates: [
        candidate({ sourceId: "web-1", kind: "knowledge", precedence: "untrusted_source" }),
        candidate({ sourceId: "agent-1", kind: "instruction", precedence: "agent_instructions" }),
        candidate({ sourceId: "safety", kind: "instruction", precedence: "platform_safety" }),
        candidate({ sourceId: "user-1" }),
      ],
    });

    expect(manifest.entries.map((entry) => entry.sourceId)).toEqual([
      "safety",
      "agent-1",
      "user-1",
      "web-1",
    ]);
    expect(INSTRUCTION_PRECEDENCE.indexOf("platform_safety")).toBe(0);
    expect(INSTRUCTION_PRECEDENCE.at(-1)).toBe("untrusted_source");
  });

  it("excludes denied sources and records the denial reason", () => {
    const manifest = assembleContext({
      ...base,
      candidates: [
        candidate(),
        candidate({
          sourceId: "secret-doc",
          kind: "knowledge",
          authorization: { decision: "deny", reason: "acl_denied" },
        }),
      ],
    });

    expect(manifest.entries.map((entry) => entry.sourceId)).toEqual(["message-1"]);
    expect(manifest.excluded).toEqual([{ sourceId: "secret-doc", reason: "acl_denied" }]);
  });

  it("keeps the transcript when a summary covers it", () => {
    const manifest = assembleContext({
      ...base,
      candidates: [
        candidate({ sourceId: "message-1" }),
        candidate({ sourceId: "message-2", digest: "sha256:message-2" }),
        candidate({
          sourceId: "summary-1",
          kind: "summary",
          summarizes: ["message-1", "message-2"],
          digest: "sha256:summary-1",
        }),
      ],
    });

    expect(manifest.entries.map((entry) => entry.sourceId)).toEqual([
      "message-1",
      "message-2",
      "summary-1",
    ]);
  });

  it("drops a summary whose sources are not all authorized", () => {
    const manifest = assembleContext({
      ...base,
      candidates: [
        candidate({ sourceId: "message-1" }),
        candidate({
          sourceId: "secret-doc",
          kind: "knowledge",
          authorization: { decision: "deny", reason: "acl_denied" },
        }),
        candidate({
          sourceId: "summary-1",
          kind: "summary",
          summarizes: ["message-1", "secret-doc"],
        }),
      ],
    });

    expect(manifest.entries.map((entry) => entry.sourceId)).toEqual(["message-1"]);
    expect(manifest.excluded).toContainEqual({
      sourceId: "summary-1",
      reason: "summary_source_unauthorized",
    });
  });

  it("drops a summary referencing a source that is not in the manifest at all", () => {
    const manifest = assembleContext({
      ...base,
      candidates: [candidate({ sourceId: "summary-1", kind: "summary", summarizes: ["ghost"] })],
    });

    expect(manifest.entries).toEqual([]);
    expect(manifest.excluded).toEqual([
      { sourceId: "summary-1", reason: "summary_source_unauthorized" },
    ]);
  });

  it("makes a summary inherit the strictest taint and classification of its sources", () => {
    const manifest = assembleContext({
      ...base,
      candidates: [
        candidate({ sourceId: "message-1" }),
        candidate({
          sourceId: "web-1",
          kind: "knowledge",
          precedence: "untrusted_source",
          taint: "untrusted",
          classification: "restricted",
        }),
        candidate({
          sourceId: "summary-1",
          kind: "summary",
          summarizes: ["message-1", "web-1"],
          taint: "trusted",
          classification: "internal",
        }),
      ],
    });

    const summary = manifest.entries.find((entry) => entry.sourceId === "summary-1");
    expect(summary).toMatchObject({ taint: "untrusted", classification: "restricted" });
  });

  it("defaults to deny when authorization is absent", () => {
    const manifest = assembleContext({
      ...base,
      candidates: [
        {
          ...candidate({ sourceId: "unchecked" }),
          authorization: undefined as unknown as ContextCandidate["authorization"],
        },
      ],
    });

    expect(manifest.entries).toEqual([]);
    expect(manifest.excluded).toEqual([{ sourceId: "unchecked", reason: "unauthorized" }]);
  });

  it("records guardrail, bundle, taint, and manifest digests", () => {
    const manifest = assembleContext({
      ...base,
      candidates: [candidate(), candidate({ sourceId: "web-1", taint: "untrusted" })],
    });

    expect(manifest.guardrailDigest).toBe("sha256:guardrail");
    expect(manifest.bundleDigest).toBe("sha256:bundle");
    expect(manifest.taint).toBe("untrusted");
    expect(manifest.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(assembleContext({ ...base, candidates: [candidate()] }).digest).not.toBe(
      manifest.digest
    );
  });

  it("never carries source content or reasoning into the manifest", () => {
    const manifest = assembleContext({
      ...base,
      candidates: [
        {
          ...candidate(),
          // A caller that smuggles content in must not see it reflected in the manifest.
          content: "the private transcript",
        } as ContextCandidate & { content: string },
      ],
    });

    expect(JSON.stringify(manifest)).not.toContain("the private transcript");
  });

  it("compacts the lowest-precedence sources first when the token budget is tight", () => {
    const manifest = assembleContext({
      ...base,
      budgetTokens: 25,
      candidates: [
        candidate({ sourceId: "safety", precedence: "platform_safety" }),
        candidate({ sourceId: "user-1", precedence: "user_request" }),
        candidate({ sourceId: "web-1", precedence: "untrusted_source", taint: "untrusted" }),
      ],
    });

    expect(manifest.entries.map((entry) => entry.sourceId)).toEqual(["safety", "user-1"]);
    expect(manifest.excluded).toEqual([{ sourceId: "web-1", reason: "context_budget" }]);
    expect(manifest.totalTokens).toBe(20);
  });

  it("fails closed rather than dropping a platform safety instruction", () => {
    expect(() =>
      assembleContext({
        ...base,
        budgetTokens: 5,
        candidates: [candidate({ sourceId: "safety", precedence: "platform_safety" })],
      })
    ).toThrow(new ContextAssemblyError("context_budget_exceeded"));
  });

  it("rejects a candidate that claims a precedence outside the fixed ladder", () => {
    expect(() =>
      assembleContext({
        ...base,
        candidates: [
          candidate({
            precedence: "override_everything" as unknown as ContextCandidate["precedence"],
          }),
        ],
      })
    ).toThrow(new ContextAssemblyError("unknown_precedence"));
  });
});
