import { describe, expect, it } from "vitest";
import {
  isPrivateEffectKind,
  projectShadowEffect,
  redactShadowEffect,
  type ShadowEffectView,
} from "./review";

const PATCH = {
  kind: "memory_patch",
  payload: {
    section: "identity",
    add: ["Lives in Bangalore", "Leads the platform team"],
    remove: ["Lives in Pune"],
    citations: [{ turnId: "t1", quote: "I moved to Bangalore" }],
  },
};

const PROPOSAL = {
  kind: "proposal",
  payload: {
    proposalKind: "create_triage_agent",
    subjectId: "integration-9",
    subjectLabel: "acme/api",
    deliver: ["task", "pill"],
    rationale: "Dhruv keeps triaging issues by hand every morning",
    citations: [{ turnId: "t2", quote: "I triage these myself" }],
  },
};

function shapeOf(view: ShadowEffectView) {
  if (view.disclosure !== "shape") throw new Error(`expected shape, got ${view.disclosure}`);
  return view.shape;
}

describe("shadow review disclosure", () => {
  it("shows a subject their own memory patch in full", () => {
    expect(redactShadowEffect(PATCH, true)).toEqual({
      disclosure: "full",
      payload: PATCH.payload,
    });
  });

  it("never leaks memory lines to anyone but their subject", () => {
    const shape = shapeOf(redactShadowEffect(PATCH, false));
    expect(shape).toEqual({
      section: "identity",
      addCount: 2,
      removeCount: 1,
      citationCount: 1,
    });
    expect(JSON.stringify(shape)).not.toContain("Bangalore");
    expect(JSON.stringify(shape)).not.toContain("Pune");
  });

  it("withholds a proposal's rationale but keeps what it targets", () => {
    const shape = shapeOf(redactShadowEffect(PROPOSAL, false));
    expect(shape).toEqual({
      proposalKind: "create_triage_agent",
      subjectLabel: "acme/api",
      deliver: ["task", "pill"],
      citationCount: 1,
    });
    expect(JSON.stringify(shape)).not.toContain("triaging");
  });

  it.each(["knowledge_promotion", "knowledge_page", "proposal_seed"])(
    "shows %s in full — it is business-bound content, not one person's",
    (kind) => {
      const effect = { kind, payload: { statement: "The team ships on Fridays" } };
      expect(redactShadowEffect(effect, false)).toEqual({
        disclosure: "full",
        payload: effect.payload,
      });
    }
  );

  it("classifies exactly the two person-scoped kinds as private", () => {
    expect(["memory_patch", "proposal"].every(isPrivateEffectKind)).toBe(true);
    expect(
      ["knowledge_promotion", "knowledge_page", "proposal_seed"].some(isPrivateEffectKind)
    ).toBe(false);
  });

  it("reports zero counts rather than throwing on a payload missing its arrays", () => {
    const shape = shapeOf(redactShadowEffect({ kind: "memory_patch", payload: {} }, false));
    expect(shape).toEqual({ addCount: 0, removeCount: 0, citationCount: 0 });
  });

  it("survives a payload that is not an object at all", () => {
    expect(shapeOf(redactShadowEffect({ kind: "proposal", payload: null }, false))).toEqual({
      citationCount: 0,
    });
  });

  it("projects a row with its disclosure decided and its date serialized", () => {
    const row = { ...PATCH, id: "eff-1", state: "shadowed", scope: "user", createdAt: new Date(0) };

    expect(projectShadowEffect(row, false)).toEqual({
      id: "eff-1",
      kind: "memory_patch",
      state: "shadowed",
      scope: "user",
      createdAt: "1970-01-01T00:00:00.000Z",
      disclosure: "shape",
      content: { section: "identity", addCount: 2, removeCount: 1, citationCount: 1 },
    });
    expect(projectShadowEffect(row, true).content).toEqual(PATCH.payload);
  });
});
