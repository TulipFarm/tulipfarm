import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import type { SoulSurfaceComponent } from "./soul";
import {
  resolveSoulSurfaceView,
  validateSoulSurfaceCatalog,
  validateSoulSurfaceComponent,
} from "./soul";

const web = { channel: "web", surface: "chat" } as const;

function statusComponent(
  slug: string,
  view: SoulSurfaceComponent["views"]["default"] = {
    component: { name: "Status", version: "1.0" },
    props: { label: { $prop: "/label" }, tone: "positive" },
  }
): SoulSurfaceComponent {
  return {
    slug,
    name: `business.${slug}`,
    version: "1.0",
    description: "A reusable business status.",
    propsSchema: Type.Object({ label: Type.String() }),
    events: [],
    examples: [{ label: "Ready" }],
    targets: [web],
    views: { default: view },
  };
}

describe("Soul Surface components", () => {
  it("resolves JSON pointer bindings into validated built-in props", () => {
    const component = statusComponent("release-status");
    const resolved = resolveSoulSurfaceView(component, web, { label: "Ready" });
    expect(resolved).toEqual({
      component: { name: "Status", version: "1.0" },
      props: { label: "Ready", tone: "positive" },
    });
  });

  it("rejects bindings that produce invalid built-in props", () => {
    const component = statusComponent("release-status");
    expect(() => resolveSoulSurfaceView(component, web, { label: 42 })).toThrow("invalid props");
  });

  it("rejects cross-component composition cycles", () => {
    const first = statusComponent("first", {
      component: { name: "business.second", version: "1.0" },
      props: { label: { $prop: "/label" } },
    });
    const second = statusComponent("second", {
      component: { name: "business.first", version: "1.0" },
      props: { label: { $prop: "/label" } },
    });
    expect(() => validateSoulSurfaceCatalog([first, second])).toThrow("Surface component cycle");
  });

  it("requires exact versions for composed business components", () => {
    const first = statusComponent("first", {
      component: { name: "business.second", version: "2.0" },
      props: { label: { $prop: "/label" } },
    });
    const second = statusComponent("second");
    expect(() => validateSoulSurfaceCatalog([first, second])).toThrow(
      "Unknown business component business.second@2.0"
    );
  });

  it("rejects undeclared target views at publication", () => {
    const component = statusComponent("release-status");
    expect(() =>
      validateSoulSurfaceComponent({
        ...component,
        views: {
          default: component.views.default,
          slack: component.views.default,
        },
      })
    ).toThrow('View "slack" does not support a declared target');
  });
});
