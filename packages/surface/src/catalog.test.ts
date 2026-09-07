import { describe, expect, it } from "vitest";
import { SHIPPED_CATALOG_REVISION, SHIPPED_SURFACE_COMPONENTS } from "./catalog";
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

  it("supports the provider-neutral Form input catalog", () => {
    const form = SHIPPED_SURFACE_COMPONENTS.find((component) => component.name === "Form");
    const inputEnum = (
      form?.propsSchema as unknown as {
        properties: {
          fields: { items: { properties: { input: { anyOf: { const: string }[] } } } };
        };
      }
    )?.properties.fields.items.properties.input.anyOf.map((literal) => literal.const);
    expect(inputEnum).toEqual([
      "text",
      "textarea",
      "email",
      "number",
      "url",
      "date",
      "time",
      "datetime",
      "richtext",
      "select",
      "multiselect",
      "checkbox",
      "radio",
      "user",
      "channel",
      "conversation",
    ]);
  });

  it("bounds Form text and multi-value constraints", () => {
    const base = {
      id: "form",
      component: { name: "Form", version: "1.0" },
      target: { channel: "web", surface: "chat" } as const,
      audience: ["user:1"],
      classification: "internal" as const,
      catalog: SHIPPED_SURFACE_COMPONENTS,
    };

    expect(() =>
      createSurfaceArtifact({
        ...base,
        props: {
          fields: [{ name: "notes", label: "Notes", input: "richtext", maxLength: 3_001 }],
          submit: "Continue",
          action: { event: "form.submit" },
        },
      })
    ).toThrow(/maxLength/);
    expect(() =>
      createSurfaceArtifact({
        ...base,
        props: {
          fields: [
            {
              name: "reviewers",
              label: "Reviewers",
              input: "multiselect",
              options: ["A"],
              maxItems: 101,
            },
          ],
          submit: "Continue",
          action: { event: "form.submit" },
        },
      })
    ).toThrow(/maxItems/);
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
