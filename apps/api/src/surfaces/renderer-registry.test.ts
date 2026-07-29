import { describe, expect, it } from "vitest";
import {
  presentationContextFor,
  surfaceCatalogFor,
  surfaceCatalogRevisionFor,
  surfaceRendererRegistry,
} from "./renderer-registry";

describe("Surface renderer registry", () => {
  it("keeps renderer-owned component support isolated by target", () => {
    const web = surfaceCatalogFor({ channel: "web", surface: "chat" });
    const telegram = surfaceCatalogFor({ channel: "telegram", surface: "message" });

    expect(web.some((component) => component.name === "ForceGraph")).toBe(true);
    expect(telegram.some((component) => component.name === "ForceGraph")).toBe(false);
    expect(telegram.some((component) => component.name === "RecordTable")).toBe(true);
  });

  it("derives Agent capabilities from the registered renderer manifest", () => {
    const context = presentationContextFor({ channel: "slack", surface: "modal" }, "channel:C123");

    expect(context.rendererCapabilities).toContain("view_submission");
    expect(surfaceRendererRegistry.manifestFor(context.target)?.renderer).toBe(
      "@tulipfarm/surface-slack/modal"
    );
  });

  it("creates a stable revision from the real target-scoped catalog", () => {
    const target = { channel: "web", surface: "chat" } as const;
    expect(surfaceCatalogRevisionFor(target)).toMatch(/^[a-f0-9]{64}$/);
    expect(surfaceCatalogRevisionFor(target)).toBe(surfaceCatalogRevisionFor(target));
  });
});
