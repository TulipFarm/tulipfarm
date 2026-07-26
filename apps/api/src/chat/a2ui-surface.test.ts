import { describe, expect, it } from "vitest";
import { MemoryA2uiSurfaceStore } from "../a2ui/artifact-surface";
import { ok } from "../tools/types";
import { a2uiEventsForToolResult } from "./a2ui-surface";

const SPEC = {
  root: {
    component: "Card",
    children: [
      { component: "MetricCard", id: "rev", value: { path: "/revenue" }, label: "Revenue" },
      { component: "Text", id: "note", text: "Static note" },
    ],
  },
};

describe("a2uiEventsForToolResult", () => {
  it("render_surface emits createSurface and persists the surface to the store", async () => {
    const store = new MemoryA2uiSurfaceStore();
    const events = await a2uiEventsForToolResult(
      "render_surface",
      ok({ surfaceId: "dash", spec: SPEC, dataModel: { revenue: "$1.2M" } }),
      { store, conversationId: "c1" }
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ op: "createSurface", surfaceId: "dash" });
    expect((events[0] as { html: string }).html).toContain("$1.2M");
    expect(await store.get("c1", "dash")).toMatchObject({ dataModel: { revenue: "$1.2M" } });
  });

  it("update_surface diffs only the changed bound leaf and emits an updateDataModel fragment", async () => {
    const store = new MemoryA2uiSurfaceStore();
    await a2uiEventsForToolResult(
      "render_surface",
      ok({ surfaceId: "dash", spec: SPEC, dataModel: { revenue: "$1.2M" } }),
      { store, conversationId: "c1" }
    );

    const events = await a2uiEventsForToolResult(
      "update_surface",
      ok({ surfaceId: "dash", dataModel: { revenue: "$1.3M" } }),
      { store, conversationId: "c1" }
    );

    expect(events).toHaveLength(1);
    const ev = events[0] as {
      op: string;
      surfaceId: string;
      fragments: Array<{ nodeId: string; html: string }>;
    };
    expect(ev.op).toBe("updateDataModel");
    expect(ev.surfaceId).toBe("dash");
    // Only the bound metric (id "rev") changed — the static Text and the container Card are untouched.
    expect(ev.fragments).toHaveLength(1);
    expect(ev.fragments[0].nodeId).toBe("rev");
    expect(ev.fragments[0].html).toContain("$1.3M");
    expect(ev.fragments[0].html).toContain('data-a2ui-id="rev"');
    // The store now holds the merged data model.
    expect(await store.get("c1", "dash")).toMatchObject({ dataModel: { revenue: "$1.3M" } });
  });

  it("update_surface emits nothing when the patch changes no bound value", async () => {
    const store = new MemoryA2uiSurfaceStore();
    await a2uiEventsForToolResult(
      "render_surface",
      ok({ surfaceId: "dash", spec: SPEC, dataModel: { revenue: "$1.2M" } }),
      { store, conversationId: "c1" }
    );
    const events = await a2uiEventsForToolResult(
      "update_surface",
      ok({ surfaceId: "dash", dataModel: { revenue: "$1.2M" } }), // same value
      { store, conversationId: "c1" }
    );
    expect(events).toHaveLength(0);
  });

  it("update_surface for an unknown surface is a no-op", async () => {
    const store = new MemoryA2uiSurfaceStore();
    const events = await a2uiEventsForToolResult(
      "update_surface",
      ok({ surfaceId: "ghost", dataModel: { x: 1 } }),
      { store, conversationId: "c1" }
    );
    expect(events).toHaveLength(0);
  });

  it("falls back to a legacy { html } event for compose_view", async () => {
    const events = await a2uiEventsForToolResult(
      "compose_view",
      ok({ html: "<tf-card></tf-card>" })
    );
    expect(events).toEqual([{ html: "<tf-card></tf-card>" }]);
  });
});
