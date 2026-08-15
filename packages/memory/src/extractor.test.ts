import { describe, expect, it } from "vitest";
import { candidatesFromResponse, MAX_CANDIDATES_PER_TURN } from "./extractor";

/** Untrusted model output must fail into no candidates, not malformed candidates. */

function response(candidates: unknown): string {
  return JSON.stringify({ candidates });
}

describe("candidatesFromResponse", () => {
  it("parses a well-formed response", () => {
    const parsed = candidatesFromResponse(
      response([
        {
          subject: "employer",
          statement: "Works at Acme as a staff engineer.",
          memoryType: "fact",
          confidence: 0.9,
          importance: 0.8,
          entities: ["Acme"],
        },
      ])
    );

    expect(parsed).toEqual([
      {
        subject: "employer",
        statement: "Works at Acme as a staff engineer.",
        memoryType: "fact",
        confidence: 0.9,
        importance: 0.8,
        entities: ["Acme"],
      },
    ]);
  });

  it("recovers JSON from a fenced response", () => {
    const raw = `Here you go:\n\`\`\`json\n${response([
      { subject: "coffee", statement: "Drinks oat milk lattes.", confidence: 0.7 },
    ])}\n\`\`\`\nHope that helps!`;

    expect(candidatesFromResponse(raw)).toHaveLength(1);
  });

  it.each([
    ["malformed JSON", "{not json at all"],
    ["no JSON", "I could not find anything worth remembering."],
    ["an empty string", ""],
    ["a JSON array rather than an object", "[1, 2, 3]"],
    ["candidates that is not an array", '{"candidates": "none"}'],
  ])("yields nothing for %s", (_label, raw) => {
    expect(candidatesFromResponse(raw)).toEqual([]);
  });

  it("clamps a confidence above 1, so a bogus score cannot clear the confidence floor", () => {
    const [candidate] = candidatesFromResponse(
      response([{ subject: "s", statement: "A fact.", confidence: 5 }])
    );

    expect(candidate?.confidence).toBe(1);
  });

  it("clamps a negative confidence to 0", () => {
    const [candidate] = candidatesFromResponse(
      response([{ subject: "s", statement: "A fact.", confidence: -3 }])
    );

    expect(candidate?.confidence).toBe(0);
  });

  it.each([
    ["high"],
    [null],
    [Number.NaN],
  ])("treats a non-numeric confidence (%s) as 0 rather than trusting it", (confidence) => {
    const [candidate] = candidatesFromResponse(
      response([{ subject: "s", statement: "A fact.", confidence }])
    );

    expect(candidate?.confidence).toBe(0);
  });

  it("defaults importance to the confidence when it is missing", () => {
    const [candidate] = candidatesFromResponse(
      response([{ subject: "s", statement: "A fact.", confidence: 0.7 }])
    );

    expect(candidate?.importance).toBe(0.7);
  });

  it("coerces a procedural memoryType to fact — procedural memory is never inferred", () => {
    const [candidate] = candidatesFromResponse(
      response([{ subject: "s", statement: "Always deploys on Friday.", memoryType: "procedural" }])
    );

    expect(candidate?.memoryType).toBe("fact");
  });

  it.each([
    ["episodic"],
    ["nonsense"],
    [42],
  ])("coerces an unusable memoryType (%s) to fact", (memoryType) => {
    const [candidate] = candidatesFromResponse(
      response([{ subject: "s", statement: "A fact.", memoryType }])
    );

    expect(candidate?.memoryType).toBe("fact");
  });

  it("keeps a declared preference type", () => {
    const [candidate] = candidatesFromResponse(
      response([{ subject: "s", statement: "Prefers dark mode.", memoryType: "preference" }])
    );

    expect(candidate?.memoryType).toBe("preference");
  });

  it.each([
    ["an empty subject", { subject: "", statement: "A fact." }],
    ["a blank subject", { subject: "   ", statement: "A fact." }],
    ["an empty statement", { subject: "s", statement: "" }],
    ["a blank statement", { subject: "s", statement: "  \n " }],
    ["a non-string subject", { subject: 7, statement: "A fact." }],
    ["a null item", null],
    ["a string item", "just text"],
  ])("drops an item with %s", (_label, item) => {
    expect(candidatesFromResponse(response([item]))).toEqual([]);
  });

  it("keeps the good items when only some are malformed", () => {
    const parsed = candidatesFromResponse(
      response([{ subject: "", statement: "dropped" }, { subject: "s", statement: "kept" }, null])
    );

    expect(parsed.map((c) => c.statement)).toEqual(["kept"]);
  });

  it("caps the number of candidates from a single turn", () => {
    const many = Array.from({ length: MAX_CANDIDATES_PER_TURN + 4 }, (_, i) => ({
      subject: `s${i}`,
      statement: `Fact ${i}.`,
    }));

    expect(candidatesFromResponse(response(many))).toHaveLength(MAX_CANDIDATES_PER_TURN);
  });

  it("drops non-string entities rather than storing them", () => {
    const [candidate] = candidatesFromResponse(
      response([{ subject: "s", statement: "A fact.", entities: ["Acme", 7, "", null, "Beta"] }])
    );

    expect(candidate?.entities).toEqual(["Acme", "Beta"]);
  });

  it("treats a non-array entities field as no entities", () => {
    const [candidate] = candidatesFromResponse(
      response([{ subject: "s", statement: "A fact.", entities: "Acme" }])
    );

    expect(candidate?.entities).toEqual([]);
  });
});
