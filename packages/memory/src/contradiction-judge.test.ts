import { describe, expect, it } from "vitest";
import {
  contradictedIdsFromResponse,
  MAX_JUDGED_PRIORS,
  renderJudgePrompt,
} from "./contradiction-judge";

/**
 * The judge's output decides whether something stops being recalled, so the parsing has to fail
 * *closed* — anything it cannot understand must yield no ids, leaving both statements standing.
 */

describe("contradictedIdsFromResponse", () => {
  it("parses a well-formed answer", () => {
    expect(contradictedIdsFromResponse('{"contradicted":["a-1","a-2"]}')).toEqual(["a-1", "a-2"]);
  });

  it("recovers the answer from surrounding prose and fences", () => {
    const raw = 'Looking at these:\n```json\n{"contradicted":["a-1"]}\n```\nThat is the only one.';
    expect(contradictedIdsFromResponse(raw)).toEqual(["a-1"]);
  });

  it("parses an explicit empty answer", () => {
    expect(contradictedIdsFromResponse('{"contradicted":[]}')).toEqual([]);
  });

  it.each([
    ["malformed JSON", "{contradicted: a-1"],
    ["no JSON at all", "None of them are contradicted."],
    ["an empty response", ""],
    ["a bare array", '["a-1"]'],
    ["a non-array field", '{"contradicted":"a-1"}'],
    ["a missing field", '{"result":["a-1"]}'],
  ])("yields nothing for %s", (_label, raw) => {
    expect(contradictedIdsFromResponse(raw)).toEqual([]);
  });

  it("drops entries that are not usable ids", () => {
    expect(contradictedIdsFromResponse('{"contradicted":["a-1",7,null,"","  ","a-2"]}')).toEqual([
      "a-1",
      "a-2",
    ]);
  });
});

describe("renderJudgePrompt", () => {
  const input = {
    businessId: "biz-1",
    statement: { subject: "employer", statement: "Works at Beta." },
    priors: [
      { assertionId: "a-1", subject: "employer", statement: "Works at Acme." },
      { assertionId: "a-2", subject: "employer", statement: "Works at Acme Corp." },
    ],
  };

  it("names the new statement and every prior with its id", () => {
    const prompt = renderJudgePrompt(input);

    expect(prompt).toContain("employer: Works at Beta.");
    expect(prompt).toContain("id: a-1");
    expect(prompt).toContain("Works at Acme.");
    expect(prompt).toContain("id: a-2");
  });

  it("never puts an owner or a scope in front of the model", () => {
    const prompt = renderJudgePrompt(input);

    expect(prompt).not.toContain("biz-1");
    expect(prompt).not.toContain("user_private");
  });

  it("caps how many priors it asks about at once", () => {
    const priors = Array.from({ length: MAX_JUDGED_PRIORS + 5 }, (_, i) => ({
      assertionId: `a-${i}`,
      subject: "employer",
      statement: `Statement ${i}.`,
    }));

    const prompt = renderJudgePrompt({ ...input, priors });

    expect(prompt.match(/id: a-/g)).toHaveLength(MAX_JUDGED_PRIORS);
  });
});
