import { surfaceActionsForArtifact, validateSurfaceArtifact } from "@tulipfarm/surface";
import { describe, expect, it } from "vitest";
import { businessExamples } from "./examples";

describe("published business examples", () => {
  it("renders only valid, public, read-only product presentations", () => {
    for (const example of businessExamples) {
      for (const step of example.steps) {
        expect(validateSurfaceArtifact(step.artifact), `${example.id}: ${step.label}`).toEqual([]);
        expect(step.artifact.classification).toBe("public");
        expect(step.artifact.target).toEqual({ channel: "web", surface: "chat" });
        expect(surfaceActionsForArtifact(step.artifact)).toEqual([]);
      }
    }
  });

  it("gives every example a distinct, serializable request and result", () => {
    expect(new Set(businessExamples.map((example) => example.request)).size).toBe(
      businessExamples.length
    );
    const ids = businessExamples.flatMap((example) =>
      example.steps.map((step) => step.artifact.id)
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(JSON.parse(JSON.stringify(businessExamples))).toEqual(businessExamples);
  });
});
