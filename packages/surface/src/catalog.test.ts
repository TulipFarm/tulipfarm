import { describe, expect, it } from "vitest";
import { SHIPPED_SURFACE_COMPONENTS, surfaceCatalogPrompt } from "./catalog";

describe("surfaceCatalogPrompt", () => {
  it("routes blocking input through request_input and explains semantic selection", () => {
    const prompt = surfaceCatalogPrompt(
      { channel: "web", surface: "chat" },
      SHIPPED_SURFACE_COMPONENTS,
      "revision"
    );

    expect(prompt).toContain("MUST call request_input instead of present");
    expect(prompt).toContain("Choices and Form always use request_input");
    expect(prompt).toContain("Alert is for an outage, degradation");
    expect(prompt).toContain("do not supply an awaitedSchema");
  });
});
