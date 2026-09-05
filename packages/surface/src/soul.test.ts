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

  it("accepts a node style from the closed token vocabulary and resolves it unbound", () => {
    const component = statusComponent("release-status", {
      component: { name: "Status", version: "1.0" },
      props: { label: { $prop: "/label" }, tone: "positive" },
      style: { tone: "warning", radius: "sm" },
    });
    expect(validateSoulSurfaceComponent(component)).toBeTruthy();
    const resolved = resolveSoulSurfaceView(component, web, { label: "Ready" });
    expect(resolved.style).toEqual({ tone: "warning", radius: "sm" });
  });

  it("rejects a style value outside the closed token vocabulary", () => {
    const component = statusComponent("release-status", {
      component: { name: "Status", version: "1.0" },
      props: { label: { $prop: "/label" }, tone: "positive" },
      style: { tone: "purple" as never },
    });
    expect(() => validateSoulSurfaceComponent(component)).toThrow("/style: invalid style");
  });

  it("resolves a style with no matching renderer CSS the same as any other valid style", () => {
    // Validation is renderer-agnostic: the surface package has no CSS at all, so a token a given
    // renderer doesn't style yet (e.g. size "md" once, before styles.css caught up) must still
    // resolve rather than being rejected for "going nowhere" visually.
    const component = statusComponent("release-status", {
      component: { name: "Status", version: "1.0" },
      props: { label: { $prop: "/label" }, tone: "positive" },
      style: { size: "md" },
    });
    const resolved = resolveSoulSurfaceView(component, web, { label: "Ready" });
    expect(resolved.style).toEqual({ size: "md" });
  });

  it("refuses a declared prop that no view reads", () => {
    // The shape that shipped a lying `business.area-chart`: it declared `fillColor`, described it
    // as the fill under the line, bound only what the shipped Chart takes, and rendered a line.
    const component: SoulSurfaceComponent = {
      ...statusComponent("area-chart"),
      propsSchema: Type.Object({ label: Type.String(), fillColor: Type.String() }),
      examples: [{ label: "Ready", fillColor: "#3b82f6" }],
    };
    expect(() => validateSoulSurfaceComponent(component)).toThrow(
      'propsSchema declares "fillColor", which no view reads'
    );
  });

  it("counts a prop read through a deep pointer as read", () => {
    const component: SoulSurfaceComponent = {
      ...statusComponent("release-status", {
        component: { name: "Status", version: "1.0" },
        props: { label: { $prop: "/rows/0/label" }, tone: "positive" },
      }),
      propsSchema: Type.Object({ rows: Type.Array(Type.Object({ label: Type.String() })) }),
      examples: [{ rows: [{ label: "Ready" }] }],
    };
    expect(validateSoulSurfaceComponent(component)).toBeTruthy();
  });

  it("does not ask a code view to bind props, since authored code gets all of them", () => {
    const component: SoulSurfaceComponent = {
      ...statusComponent("budget-sheet"),
      propsSchema: Type.Object({ label: Type.String(), fillColor: Type.String() }),
      examples: [{ label: "Ready", fillColor: "#3b82f6" }],
      code: {
        web: { source: "function render(){}", compiled: "function render(){}", sourceSha256: "a" },
      },
    };
    expect(validateSoulSurfaceComponent(component)).toBeTruthy();
  });

  it("accepts a component whose only web view is authored code", () => {
    const component: SoulSurfaceComponent = {
      ...statusComponent("budget-sheet"),
      views: {},
      code: {
        web: { source: "function render(){}", compiled: "function render(){}", sourceSha256: "a" },
      },
    };
    expect(validateSoulSurfaceComponent(component)).toBeTruthy();
    expect(validateSoulSurfaceCatalog([component])).toHaveLength(1);
  });

  it("refuses a code view for a channel that cannot execute one", () => {
    const component = {
      ...statusComponent("budget-sheet"),
      targets: [web, { channel: "slack", surface: "message" }],
      code: {
        slack: {
          source: "function render(){}",
          compiled: "function render(){}",
          sourceSha256: "a",
        },
      },
    } as unknown as SoulSurfaceComponent;
    expect(() => validateSoulSurfaceComponent(component)).toThrow(
      "/code/slack: a code view supports the web channel only"
    );
  });

  it("refuses to resolve a code view into a tree", () => {
    const component: SoulSurfaceComponent = {
      ...statusComponent("budget-sheet"),
      views: {},
      code: {
        web: { source: "function render(){}", compiled: "function render(){}", sourceSha256: "a" },
      },
    };
    expect(() => resolveSoulSurfaceView(component, web, { label: "Ready" })).toThrow(
      "a code view renders in a sandbox"
    );
  });

  it("refuses to compose a code-backed component into another component", () => {
    const inner: SoulSurfaceComponent = {
      ...statusComponent("inner"),
      views: {},
      code: {
        web: { source: "function render(){}", compiled: "function render(){}", sourceSha256: "a" },
      },
    };
    const outer = statusComponent("outer", {
      component: { name: "business.inner", version: "1.0" },
      props: { label: { $prop: "/label" } },
    });
    expect(() => resolveSoulSurfaceView(outer, web, { label: "Ready" }, [outer, inner])).toThrow(
      "cannot be composed into another component"
    );
  });

  it("does not count authored source against the semantic publication limit", () => {
    const component: SoulSurfaceComponent = {
      ...statusComponent("budget-sheet"),
      views: {},
      code: {
        web: {
          source: `//${"x".repeat(60_000)}`,
          compiled: `//${"x".repeat(120_000)}`,
          sourceSha256: "a",
        },
      },
    };
    expect(validateSoulSurfaceComponent(component)).toBeTruthy();
  });

  it("lets an outer business-component reference override the style of the view it composes", () => {
    const inner = statusComponent("inner", {
      component: { name: "Status", version: "1.0" },
      props: { label: { $prop: "/label" }, tone: "positive" },
      style: { tone: "positive" },
    });
    const outer = statusComponent("outer", {
      component: { name: "business.inner", version: "1.0" },
      props: { label: { $prop: "/label" } },
      style: { tone: "negative" },
    });
    const resolved = resolveSoulSurfaceView(outer, web, { label: "Ready" }, [outer, inner]);
    expect(resolved.style).toEqual({ tone: "negative" });
  });
});
