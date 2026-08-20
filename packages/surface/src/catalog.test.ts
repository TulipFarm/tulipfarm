import { describe, expect, it } from "vitest";
import {
  SHIPPED_CATALOG_REVISION,
  SHIPPED_SURFACE_COMPONENTS,
  surfaceCatalogPrompt,
} from "./catalog";
import { createSurfaceArtifact, validateSurfaceArtifact } from "./index";

describe("SHIPPED_SURFACE_COMPONENTS", () => {
  it("includes Divider, Image, and MultiChoice with self-validated examples", () => {
    const names = SHIPPED_SURFACE_COMPONENTS.map((component) => component.name);
    expect(names).toEqual(expect.arrayContaining(["Divider", "Image", "MultiChoice"]));
  });

  it("includes data-display components with valid shipped examples", () => {
    const names = ["Metric", "Timeline", "Comparison", "Breakdown", "Gauge"];
    for (const name of names) {
      const component = SHIPPED_SURFACE_COMPONENTS.find((candidate) => candidate.name === name);
      expect(component).toBeDefined();
      const example = component?.examples[0] as Record<string, unknown> | undefined;
      expect(example).toBeDefined();
      expect(() =>
        createSurfaceArtifact({
          id: name,
          component: { name, version: "1.0" },
          props: example ?? {},
          target: { channel: "web", surface: "chat" },
          audience: ["user:1"],
          classification: "internal",
        })
      ).not.toThrow();
    }
  });

  it("widens Form.fields[].input to include multiselect and radio", () => {
    const form = SHIPPED_SURFACE_COMPONENTS.find((component) => component.name === "Form");
    const inputEnum = (
      form?.propsSchema as unknown as {
        properties: {
          fields: { items: { properties: { input: { anyOf: { const: string }[] } } } };
        };
      }
    )?.properties.fields.items.properties.input.anyOf.map((literal) => literal.const);
    expect(inputEnum).toEqual(expect.arrayContaining(["multiselect", "radio"]));
  });

  it("keeps recommendation props optional so a neutral Choices still validates", () => {
    // A card that leads with one option is the agent making a recommendation. The schema must let
    // the agent decline to make one, or every question grows a preference it never expressed.
    const neutral = createSurfaceArtifact({
      id: "neutral",
      component: { name: "Choices", version: "1.0" },
      props: {
        question: "Which environment?",
        choices: [
          { label: "Production", value: "production" },
          { label: "Staging", value: "staging" },
        ],
        action: { event: "environment.choose" },
      },
      target: { channel: "web", surface: "chat" },
      audience: ["user:1"],
      classification: "internal",
    });

    expect(validateSurfaceArtifact(neutral, SHIPPED_SURFACE_COMPONENTS)).toEqual([]);
  });

  it("validates the shipped Choices example, recommendation and all", () => {
    const choices = SHIPPED_SURFACE_COMPONENTS.find((candidate) => candidate.name === "Choices");
    const example = choices?.examples[0] as Record<string, unknown> | undefined;
    expect(example?.recommend).toBeDefined();

    const artifact = createSurfaceArtifact({
      id: "choices",
      component: { name: "Choices", version: "1.0" },
      props: example ?? {},
      target: { channel: "web", surface: "chat" },
      audience: ["user:1"],
      classification: "internal",
    });

    expect(validateSurfaceArtifact(artifact, SHIPPED_SURFACE_COMPONENTS)).toEqual([]);
  });

  it("rejects a confidence the meter cannot draw", () => {
    // The meter has three bars and no fourth state, so an unknown confidence has no rendering.
    expect(() =>
      createSurfaceArtifact({
        id: "bad",
        component: { name: "Choices", version: "1.0" },
        props: {
          question: "Which environment?",
          choices: [{ label: "Production", value: "production", confidence: "certain" }],
          action: { event: "environment.choose" },
        },
        target: { channel: "web", surface: "chat" },
        audience: ["user:1"],
        classification: "internal",
        catalog: SHIPPED_SURFACE_COMPONENTS,
      })
    ).toThrow(/confidence/);
  });

  it("bumps the shipped catalog revision", () => {
    expect(SHIPPED_CATALOG_REVISION).toBe("tsp-1.2-data-display-1");
  });
});

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
    expect(prompt).toContain("Metric is one or more KPIs");
    expect(prompt).toContain("Breakdown is a proportional split");
    expect(prompt).toContain("do not supply an awaitedSchema");
    expect(prompt).toContain("recommend");
    // The label becomes the commit button, so a bare identifier leaves the reader pressing a noun.
    expect(prompt).toContain("never as a bare identifier");
  });
});
