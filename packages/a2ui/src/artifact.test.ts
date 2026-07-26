import { describe, expect, it } from "vitest";
import { createA2UIArtifact } from "./artifact";

describe("createA2UIArtifact", () => {
  it("creates a stable immutable A2UI Artifact with governance metadata", () => {
    const input = {
      id: "artifact-1",
      businessId: "business-1",
      createdBy: "user:alice",
      classification: "internal" as const,
      audience: ["user:alice"],
      retention: "P30D",
      lineage: ["run:run-1"],
      spec: { version: "1", root: { component: "Text" as const, text: "hello" } },
    };

    const first = createA2UIArtifact(input);
    const second = createA2UIArtifact(input);

    expect(first).toMatchObject({
      id: "artifact-1",
      type: "a2ui_surface",
      classification: "internal",
      audience: ["user:alice"],
      lineage: ["run:run-1"],
      redactionState: "unredacted",
    });
    expect(first.hash).toBe(second.hash);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.spec)).toBe(true);
  });
});
