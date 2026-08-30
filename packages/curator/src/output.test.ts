import { describe, expect, it } from "vitest";
import { parseCuratorBusinessOutput, parseCuratorUserOutput } from "./output";

const CITATION = [{ turnId: "t1", quote: "I live in Bangalore" }];

describe("parseCuratorUserOutput", () => {
  it("accepts a well-formed output", () => {
    const result = parseCuratorUserOutput({
      memory: [{ section: "identity", add: ["Lives in Bangalore"], citations: CITATION }],
      proposals: [],
      knowledgePromotions: [],
    });
    expect(result.ok).toBe(true);
  });

  it("reads the output back out of a JSON string", () => {
    const result = parseCuratorUserOutput(JSON.stringify({ memory: [] }));
    expect(result).toEqual({
      ok: true,
      output: { memory: [], proposals: [], knowledgePromotions: [] },
    });
  });

  // "I found nothing worth writing" is the right answer most of the time, so it must not look
  // like a failure in the metrics.
  it("treats an empty object as a legitimate no-op", () => {
    expect(parseCuratorUserOutput({})).toEqual({
      ok: true,
      output: { memory: [], proposals: [], knowledgePromotions: [] },
    });
  });

  it.each([["prose, not JSON"], [null], [[]], [42]])("rejects %j as unparsable", (raw) => {
    expect(parseCuratorUserOutput(raw)).toEqual({ ok: false, rejection: { reason: "unparsable" } });
  });

  it("reports which field failed, because rejection reasons are a metric", () => {
    const result = parseCuratorUserOutput({
      memory: [{ section: "invented_section", add: ["x"], citations: CITATION }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.rejection.reason === "schema") {
      expect(result.rejection.detail).toContain("/memory/0/section");
    }
  });

  it("rejects an unknown proposal kind", () => {
    const result = parseCuratorUserOutput({
      proposals: [
        {
          kind: "delete_everything",
          subjectId: "x",
          deliver: ["task"],
          rationale: "r",
          citations: CITATION,
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  // Every claim must be answerable with "where did you read that", so an uncited one never even
  // reaches the citation checker.
  it("rejects a memory patch with no citations", () => {
    expect(parseCuratorUserOutput({ memory: [{ section: "identity", add: ["x"] }] }).ok).toBe(
      false
    );
  });

  it("rejects unknown properties rather than ignoring them", () => {
    expect(parseCuratorUserOutput({ memory: [], applyDirectly: true }).ok).toBe(false);
  });

  it("rejects a delivery channel it does not have", () => {
    const result = parseCuratorUserOutput({
      proposals: [
        {
          kind: "add_skill_to_agent",
          subjectId: "a",
          deliver: ["email"],
          rationale: "r",
          citations: CITATION,
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  // A patch naming neither add nor remove is a no-op the schema cannot express as required, so it
  // is dropped here rather than becoming an effect that does nothing.
  it("drops a patch that would change nothing", () => {
    const result = parseCuratorUserOutput({
      memory: [
        { section: "identity", citations: CITATION },
        { section: "preferences", add: ["Prefers short answers"], citations: CITATION },
      ],
    });
    expect(result.ok && result.output.memory).toHaveLength(1);
  });

  // The prompt tells the model "returning empty arrays is a good answer", so it routinely emits
  // `"remove": []` alongside a real `add`. `minItems: 1` on that array used to fail the whole
  // output's schema validation, discarding the valid `add` with it — the staging rejection was
  // exactly `/memory/0/remove must NOT have fewer than 1 items`. An empty array must be accepted
  // and treated the same as an absent key.
  it("keeps a valid add when remove is an empty array, not the whole output", () => {
    const result = parseCuratorUserOutput({
      memory: [
        {
          section: "identity",
          add: ["Lives in Bangalore"],
          remove: [],
          citations: CITATION,
        },
      ],
    });
    expect(result).toEqual({
      ok: true,
      output: {
        memory: [
          { section: "identity", add: ["Lives in Bangalore"], remove: [], citations: CITATION },
        ],
        proposals: [],
        knowledgePromotions: [],
      },
    });
  });

  // Both arrays empty is still a no-op, even though each one is now individually schema-legal.
  it("drops a patch whose add and remove are both empty arrays", () => {
    const result = parseCuratorUserOutput({
      memory: [{ section: "identity", add: [], remove: [], citations: CITATION }],
    });
    expect(result.ok && result.output.memory).toHaveLength(0);
  });
});

describe("parseCuratorBusinessOutput", () => {
  it("accepts a well-formed output", () => {
    const result = parseCuratorBusinessOutput({
      knowledge: [{ candidateIds: ["c1"], title: "Release process", body: "We ship Thursdays." }],
      proposalSeeds: [{ kind: "create_resource_type", subjectId: "tickets", rationale: "r" }],
    });
    expect(result.ok).toBe(true);
  });

  // The business Run aggregates several people, so it has no audience to name — a Proposal or a
  // Memory patch coming back from it is a scope violation, not a schema nicety.
  it("has no way to express a memory patch or an audience", () => {
    expect(parseCuratorBusinessOutput({ memory: [{ section: "identity" }] }).ok).toBe(false);
    expect(
      parseCuratorBusinessOutput({
        proposalSeeds: [
          { kind: "create_resource_type", subjectId: "t", rationale: "r", audience: "u1" },
        ],
      }).ok
    ).toBe(false);
  });

  it("requires a page to say which candidates it came from", () => {
    expect(parseCuratorBusinessOutput({ knowledge: [{ title: "t", body: "b" }] }).ok).toBe(false);
    expect(
      parseCuratorBusinessOutput({ knowledge: [{ candidateIds: [], title: "t", body: "b" }] }).ok
    ).toBe(false);
  });
});
