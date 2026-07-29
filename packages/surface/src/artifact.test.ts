import { describe, expect, it } from "vitest";
import {
  createSurfaceArtifact,
  createSurfaceRegistry,
  SurfaceValidationError,
  updateSurfaceArtifact,
} from "./index";

const web = { channel: "web", surface: "chat" } as const;

describe("SurfaceArtifact", () => {
  it("validates props and performs optimistic revisions", () => {
    const first = createSurfaceArtifact({
      id: "artifact-1",
      component: { name: "Status", version: "1.0" },
      props: { label: "Ready", tone: "positive" },
      target: web,
      audience: ["user:1"],
      classification: "internal",
    });
    const second = updateSurfaceArtifact(first, 1, { label: "Done", tone: "positive" });
    expect(second.revision).toBe(2);
    expect(() => updateSurfaceArtifact(second, 1, { label: "stale" })).toThrow(
      SurfaceValidationError
    );
  });

  it("isolates web-only components from other target catalogs", () => {
    const registry = createSurfaceRegistry([
      {
        renderer: "test/telegram",
        targets: [{ channel: "telegram", surface: "message" }],
        components: { RecordTable: ["1.0"] },
        providerLimits: {},
        interactionCapabilities: [],
      },
    ]);
    const telegram = registry.catalogFor({ channel: "telegram", surface: "message" });
    expect(telegram.some((component) => component.name === "Chart")).toBe(false);
    expect(telegram.some((component) => component.name === "RecordTable")).toBe(true);
  });

  it("rejects components omitted by the selected renderer manifest", () => {
    const manifest = {
      renderer: "test/telegram",
      targets: [{ channel: "telegram", surface: "message" }],
      components: { RecordTable: ["1.0"] },
      providerLimits: {},
      interactionCapabilities: [],
    } as const;

    expect(() =>
      createSurfaceArtifact({
        id: "artifact-chart",
        component: { name: "Chart", version: "1.0" },
        props: { kind: "bar", labels: ["A", "B"], series: [{ label: "Value", values: [1, 2] }] },
        target: { channel: "telegram", surface: "message" },
        audience: ["user:1"],
        classification: "internal",
        rendererManifest: manifest,
      })
    ).toThrow("does not support this target");
  });
});
