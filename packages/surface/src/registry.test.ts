import { describe, expect, it } from "vitest";
import { createSurfaceRegistry } from "./registry";

describe("SurfaceRegistry", () => {
  it("rejects manifests that advertise unknown component versions", () => {
    expect(() =>
      createSurfaceRegistry([
        {
          renderer: "test/web",
          targets: [{ channel: "web", surface: "chat" }],
          components: { Heading: ["2.0"] },
          providerLimits: {},
          interactionCapabilities: [],
        },
      ])
    ).toThrow("unknown Surface component Heading@2.0");
  });

  it("rejects two renderers registered for the same target", () => {
    const manifest = {
      targets: [{ channel: "web", surface: "chat" }],
      components: { Heading: ["1.0"] },
      providerLimits: {},
      interactionCapabilities: [],
    } as const;

    expect(() =>
      createSurfaceRegistry([
        { ...manifest, renderer: "test/first" },
        { ...manifest, renderer: "test/second" },
      ])
    ).toThrow("Multiple Surface renderers");
  });

  it("hashes shipped TypeBox schemas through their JSON representation", () => {
    const target = { channel: "web", surface: "chat" } as const;
    const registry = createSurfaceRegistry([
      {
        renderer: "test/web",
        targets: [target],
        components: { Heading: ["1.0"] },
        providerLimits: {},
        interactionCapabilities: [],
      },
    ]);

    expect(registry.catalogRevision(target)).toMatch(/^[a-f0-9]{64}$/);
    expect(registry.catalogRevision(target)).toBe(registry.catalogRevision(target));
  });
});
