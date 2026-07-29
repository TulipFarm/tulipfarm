import { createSurfaceArtifact } from "@tulipfarm/surface";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SurfaceCompositionView, surfaceWebRenderer } from "./index";

describe("surfaceWebRenderer", () => {
  it("renders trusted React without accepting markup", () => {
    const artifact = createSurfaceArtifact({
      id: "status",
      component: { name: "Status", version: "1.0" },
      props: { label: "Ready", tone: "positive" },
      target: { channel: "web", surface: "chat" },
      audience: ["user:1"],
      classification: "internal",
    });
    const markup = renderToStaticMarkup(
      surfaceWebRenderer.render(artifact, { destination: "chat" })
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain("data-surface-status");
    expect(markup).toContain('data-tone="positive"');
  });

  it("renders a resolved business composition through trusted components", () => {
    const artifact = {
      ...createSurfaceArtifact({
        id: "status",
        component: { name: "Status", version: "1.0" },
        props: { label: "Ready" },
        target: { channel: "web", surface: "chat" },
        audience: ["user:1"],
        classification: "internal",
      }),
      component: { name: "business.release-status", version: "1.0" },
    };
    const markup = renderToStaticMarkup(
      <SurfaceCompositionView
        artifact={artifact}
        view={{
          component: { name: "Status", version: "1.0" },
          props: { label: "Ready", tone: "positive" },
        }}
      />
    );
    expect(markup).toContain('data-surface-component="Status"');
    expect(markup).toContain("Ready");
  });

  it("renders Record tables with accessible headers and styling hooks", () => {
    const artifact = createSurfaceArtifact({
      id: "pipeline",
      component: { name: "RecordTable", version: "1.0" },
      props: {
        columns: ["company", "status", "value"],
        records: [
          { company: "Acme", status: "Qualified", value: "$42,000" },
          { company: "Globex", status: "Proposal", value: "$75,000" },
        ],
      },
      target: { channel: "web", surface: "chat" },
      audience: ["user:1"],
      classification: "internal",
    });

    const markup = renderToStaticMarkup(
      surfaceWebRenderer.render(artifact, { destination: "chat" })
    );
    expect(markup).toContain("data-surface-table-scroll");
    expect(markup).toContain("data-surface-record-table");
    expect(markup).toContain('data-surface-kind="record-table"');
    expect(markup).toContain('<th scope="col">Company</th>');
  });

  it("renders alerts and choices with distinct semantic styling hooks", () => {
    const alert = createSurfaceArtifact({
      id: "incident",
      component: { name: "Alert", version: "1.0" },
      props: {
        title: "Checkout degraded",
        message: "Payment attempts are failing.",
        severity: "error",
      },
      target: { channel: "web", surface: "chat" },
      audience: ["user:1"],
      classification: "internal",
    });
    const choices = createSurfaceArtifact({
      id: "decision",
      component: { name: "Choices", version: "1.0" },
      props: {
        question: "What should we do?",
        choices: [{ label: "Roll back", value: "rollback" }],
        action: { event: "incident.choose" },
      },
      target: { channel: "web", surface: "chat" },
      audience: ["user:1"],
      classification: "internal",
    });
    const handleFor = () => "sf_choice";

    const alertMarkup = renderToStaticMarkup(
      surfaceWebRenderer.render(alert, { destination: "chat" })
    );
    const choicesMarkup = renderToStaticMarkup(
      surfaceWebRenderer.render(choices, {
        destination: "chat",
        actionHandleFor: handleFor,
      })
    );

    expect(alertMarkup).toContain("data-surface-alert");
    expect(alertMarkup).toContain('data-severity="error"');
    expect(choicesMarkup).toContain("data-surface-choices");
    expect(choicesMarkup).toContain("data-surface-choices-header");
    expect(choicesMarkup).toContain("data-surface-choice-list");
    expect(choicesMarkup).not.toContain("<fieldset");
    expect(choicesMarkup).toContain("data-surface-button");
    expect(choicesMarkup).toContain('data-surface-action="sf_choice"');
  });

  it("uses the shared panel grammar for informational components", () => {
    const components = [
      {
        name: "Section",
        props: { heading: "Summary", body: "Three records need attention." },
        kind: "section",
      },
      {
        name: "Card",
        props: { title: "Acme", body: "Renewal due Friday.", status: "Open" },
        kind: "card",
      },
      {
        name: "List",
        props: { items: ["Draft", "Review", "Publish"], ordered: true },
        kind: "list",
      },
      {
        name: "RecordDetail",
        props: { title: "Acme", record: { account_owner: "Sam", status: "Open" } },
        kind: "record-detail",
      },
    ] as const;

    for (const component of components) {
      const artifact = createSurfaceArtifact({
        id: component.name,
        component: { name: component.name, version: "1.0" },
        props: component.props,
        target: { channel: "web", surface: "chat" },
        audience: ["user:1"],
        classification: "internal",
      });
      const markup = renderToStaticMarkup(
        surfaceWebRenderer.render(artifact, { destination: "chat" })
      );

      expect(markup).toContain("data-surface-panel");
      expect(markup).toContain("data-surface-panel-header");
      expect(markup).toContain("data-surface-panel-body");
      expect(markup).toContain(`data-surface-kind="${component.kind}"`);
    }
  });

  it("renders typed forms with native controls and the shared card structure", () => {
    const artifact = createSurfaceArtifact({
      id: "contact",
      component: { name: "Form", version: "1.0" },
      props: {
        title: "Contact details",
        fields: [
          { name: "email", label: "Email", input: "email", required: true },
          { name: "notes", label: "Notes", input: "textarea" },
          {
            name: "priority",
            label: "Priority",
            input: "select",
            options: ["Low", "High"],
          },
          { name: "subscribe", label: "Send updates", input: "checkbox" },
        ],
        submit: "Continue",
        action: { event: "contact.submit" },
      },
      target: { channel: "web", surface: "chat" },
      audience: ["user:1"],
      classification: "internal",
    });

    const markup = renderToStaticMarkup(
      surfaceWebRenderer.render(artifact, {
        destination: "chat",
        actionHandleFor: () => "sf_form",
      })
    );

    expect(markup).toContain("data-surface-form");
    expect(markup).toContain('type="email"');
    expect(markup).toContain("<textarea");
    expect(markup).toContain("<select");
    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain('type="submit"');
    expect(markup).toContain('data-surface-action="sf_form"');
  });

  it("renders charts and ForceGraphs as accessible native SVG instead of JSON", () => {
    const chart = createSurfaceArtifact({
      id: "revenue",
      component: { name: "Chart", version: "1.0" },
      props: {
        kind: "line",
        labels: ["Q1", "Q2", "Q3"],
        series: [{ label: "Revenue", values: [4, 7, 9] }],
      },
      target: { channel: "web", surface: "chat" },
      audience: ["user:1"],
      classification: "internal",
    });
    const graph = createSurfaceArtifact({
      id: "relationships",
      component: { name: "ForceGraph", version: "1.0" },
      props: {
        nodes: [
          { id: "acme", label: "Acme" },
          { id: "globex", label: "Globex" },
        ],
        edges: [{ source: "acme", target: "globex" }],
      },
      target: { channel: "web", surface: "chat" },
      audience: ["user:1"],
      classification: "internal",
    });

    const chartMarkup = renderToStaticMarkup(
      surfaceWebRenderer.render(chart, { destination: "chat" })
    );
    const graphMarkup = renderToStaticMarkup(
      surfaceWebRenderer.render(graph, { destination: "chat" })
    );

    expect(chartMarkup).toContain("data-surface-chart");
    expect(chartMarkup).toContain('role="img"');
    expect(chartMarkup).toContain("data-surface-chart-line");
    expect(chartMarkup).not.toContain("<pre");
    expect(graphMarkup).toContain("data-surface-force-graph");
    expect(graphMarkup).toContain("data-surface-graph-nodes");
    expect(graphMarkup).not.toContain("<pre");
  });
});
