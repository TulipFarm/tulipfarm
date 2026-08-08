import { describe, expect, it } from "vitest";
import {
  SHIPPED_CATALOG_REVISION,
  SHIPPED_SURFACE_COMPONENTS,
  surfaceCatalogPrompt,
} from "./catalog";

describe("SHIPPED_SURFACE_COMPONENTS", () => {
  it("includes Divider, Image, and MultiChoice with self-validated examples", () => {
    const names = SHIPPED_SURFACE_COMPONENTS.map((component) => component.name);
    expect(names).toEqual(expect.arrayContaining(["Divider", "Image", "MultiChoice"]));
  });

  it("widens Form.fields[].input to include multiselect and radio", () => {
    const form = SHIPPED_SURFACE_COMPONENTS.find((component) => component.name === "Form");
    const inputEnum = (
      form?.propsSchema as unknown as {
        properties: {
          fields: { items: { properties: { input: { anyOf: { const: string }[] } } } };
        };
      }
    ).properties.fields.items.properties.input.anyOf.map((literal) => literal.const);
    expect(inputEnum).toEqual(expect.arrayContaining(["multiselect", "radio"]));
  });

  it("bumps the shipped catalog revision", () => {
    expect(SHIPPED_CATALOG_REVISION).toBe("tsp-1.1-builtins-1");
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
    expect(prompt).toContain("do not supply an awaitedSchema");
  });
});
