import { describe, expect, it } from "vitest";
import { compileSurface } from "./compiler";
import type { A2uiSpec } from "./spec";

describe("compileSurface", () => {
  it("compiles a nested tree to tf-* HTML", () => {
    const spec: A2uiSpec = {
      root: {
        component: "Card",
        children: [
          { component: "Heading", text: "Q2 Sales" },
          { component: "Text", text: "Steady growth.", tone: "muted" },
        ],
      },
    };
    const { html } = compileSurface(spec);
    expect(html).toContain("<tf-card");
    expect(html).toContain("<tf-heading");
    expect(html).toContain("Q2 Sales");
    expect(html).toContain(`<tf-text data-tone="muted"`);
    expect(html).toContain("Steady growth.");
  });

  it("resolves {path} bindings against the data model", () => {
    const spec: A2uiSpec = {
      root: {
        component: "MetricCard",
        value: { path: "/revenue" },
        label: "Revenue",
        trend: "up",
      },
    };
    const { html } = compileSurface(spec, { revenue: "$1.2M" });
    expect(html).toContain(`<tf-metric-card data-trend="up"`);
    expect(html).toContain(`<span data-slot="value">$1.2M</span>`);
    expect(html).toContain(`<span data-slot="label">Revenue</span>`);
  });

  it("resolves nested + missing paths (missing → empty)", () => {
    const spec: A2uiSpec = {
      root: [
        { component: "Text", text: { path: "/a/b" } },
        { component: "Text", text: { path: "/missing" } },
      ],
    };
    const { html } = compileSurface(spec, { a: { b: "deep" } });
    expect(html).toContain(">deep</tf-text>");
    expect(html).toContain("<tf-text data-a2ui-id"); // the missing one still renders, empty
  });

  it("returns per-node HTML flagging containers (Card) vs leaves (Text) for live-update diffing", () => {
    const spec: A2uiSpec = {
      root: {
        component: "Card",
        id: "card",
        children: [{ component: "Text", id: "t", text: "x" }],
      },
    };
    const { nodes } = compileSurface(spec);
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    expect(byId.card.leaf).toBe(false); // container — no bound props, never swapped
    expect(byId.t.leaf).toBe(true); // leaf — the diff/swap unit
    expect(byId.t.html).toContain('data-a2ui-id="t"');
  });

  it("stamps every node with a data-a2ui-id and reports nodeIds in order", () => {
    const spec: A2uiSpec = {
      root: { component: "Card", children: [{ component: "Text", text: "x" }] },
    };
    const { html, nodeIds } = compileSurface(spec);
    expect(nodeIds).toEqual(["a2-0", "a2-1"]);
    expect(html).toContain(`data-a2ui-id="a2-0"`);
    expect(html).toContain(`data-a2ui-id="a2-1"`);
  });

  it("uses an author-provided id when present", () => {
    const spec: A2uiSpec = { root: { component: "Text", id: "greeting", text: "hi" } };
    const { html, nodeIds } = compileSurface(spec);
    expect(nodeIds).toEqual(["greeting"]);
    expect(html).toContain(`data-a2ui-id="greeting"`);
  });

  it("serializes a button action into an escaped data-a2ui-send payload", () => {
    const spec: A2uiSpec = {
      root: {
        component: "Button",
        label: "Approve",
        action: { descriptor: "payload.signature" },
      },
    };
    const { html } = compileSurface(spec);
    expect(html).toContain("&quot;kind&quot;:&quot;a2ui-action&quot;");
    expect(html).toContain("&quot;descriptor&quot;:&quot;payload.signature&quot;");
    expect(html).not.toContain("&quot;event&quot;");
  });

  it("HTML-escapes agent values so a label cannot break out of the tag/attribute", () => {
    const spec: A2uiSpec = {
      root: { component: "Text", text: `"><tf-button data-a2ui-send="{}">x` },
    };
    const { html } = compileSurface(spec);
    expect(html).not.toContain('"><tf-button data-a2ui-send="{}">');
    expect(html).toContain("&lt;tf-button");
    expect([...html.matchAll(/<tf-button /g)]).toHaveLength(0);
  });

  it("compiles a chart with JSON data-labels / data-datasets attributes", () => {
    const spec: A2uiSpec = {
      root: {
        component: "BarChart",
        labels: { path: "/labels" },
        datasets: [{ label: "Sales", data: [1, 2, 3] }],
      },
    };
    const { html } = compileSurface(spec, { labels: ["Jan", "Feb", "Mar"] });
    expect(html).toContain("<tf-chart-bar");
    expect(html).toContain(`data-labels="${"[&quot;Jan&quot;,&quot;Feb&quot;,&quot;Mar&quot;]"}"`);
    expect(html).toContain("&quot;label&quot;:&quot;Sales&quot;");
  });

  it("compiles a ForceGraph with JSON data-nodes / data-edges attributes", () => {
    const spec: A2uiSpec = {
      root: {
        component: "ForceGraph",
        nodes: { path: "/nodes" },
        edges: [{ source: "orders", target: "customers", broken: false }],
      },
    };
    const { html } = compileSurface(spec, {
      nodes: [{ id: "orders", label: "Orders" }],
    });
    expect(html).toContain("<tf-force-graph");
    expect(html).toContain("data-nodes=");
    expect(html).toContain("&quot;id&quot;:&quot;orders&quot;");
    expect(html).toContain("&quot;target&quot;:&quot;customers&quot;");
  });

  it("compiles a DataTable with an aria-sort header", () => {
    const spec: A2uiSpec = {
      root: {
        component: "DataTable",
        columns: ["id", "name"],
        rows: [["1", "Ada"]],
        sort: { column: "id", direction: "ascending" },
      },
    };
    const { html } = compileSurface(spec);
    expect(html).toContain(`<th aria-sort="ascending">id</th>`);
    expect(html).toContain("<td>Ada</td>");
  });

  it("compiles a Form with fields and a submit button carrying an a2ui-form payload", () => {
    const spec: A2uiSpec = {
      root: {
        component: "Form",
        action: { descriptor: "payload.signature" },
        submitLabel: "Save",
        fields: [
          { name: "city", label: "City", input: "text", value: "Pune", required: true },
          {
            name: "size",
            label: "Size",
            input: "select",
            value: "S",
            options: [
              { label: "Small", value: "S" },
              { label: "Large", value: "L" },
            ],
          },
        ],
      },
    };
    const { html } = compileSurface(spec);
    expect(html).toContain("<tf-schema-form");
    expect(html).toContain(`data-name="city"`);
    expect(html).toContain(`value="Pune"`);
    expect(html).toContain(`<option value="S" selected>Small</option>`);
    expect(html).toContain("&quot;kind&quot;:&quot;a2ui-form&quot;");
    expect(html).toContain(">Save</tf-button>");
  });

  it("rejects unknown components", () => {
    const spec = {
      root: [{ component: "Nope" }, { component: "Text", text: "ok" }],
    } as unknown as A2uiSpec;
    expect(() => compileSurface(spec)).toThrow(/A2UI schema/);
  });

  it("rejects a loose or malformed spec", () => {
    const spec = {
      root: {
        component: "Form",
        action: { descriptor: "payload.signature" },
        fields: [{}, { input: "select" }, { name: "city" }],
      },
    } as unknown as A2uiSpec;
    expect(() => compileSurface(spec)).toThrow(/A2UI schema/);
    const malformed = {
      root: [
        { component: "Text" },
        { component: "MetricCard" },
        { component: "DataTable", columns: [undefined], rows: [[undefined]] },
        { component: "BarChart" },
      ],
    } as unknown as A2uiSpec;
    expect(() => compileSurface(malformed)).toThrow(/A2UI schema/);
  });
});
