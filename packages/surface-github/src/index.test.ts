import { createSurfaceArtifact } from "@tulipfarm/surface";
import { describe, expect, it } from "vitest";
import { githubCommentRenderer } from "./index";

describe("githubCommentRenderer", () => {
  it("renders a Record table as Markdown", () => {
    const artifact = createSurfaceArtifact({
      id: "records",
      component: { name: "RecordTable", version: "1.0" },
      props: {
        columns: ["name", "status"],
        records: [
          { name: "Acme", status: "Open" },
          { name: "Globex", status: "Won" },
        ],
      },
      target: { channel: "github", surface: "comment" },
      audience: ["user:1"],
      classification: "internal",
    });
    expect(githubCommentRenderer.render(artifact, { destination: "issue:1" })).toEqual({
      kind: "comment",
      body: "| name | status |\n| --- | --- |\n| Acme | Open |\n| Globex | Won |",
    });
  });

  it("renders data-display components as Markdown fallbacks", () => {
    const samples = [
      {
        id: "metric",
        component: { name: "Metric", version: "1.0" },
        props: { cells: [{ label: "Revenue", value: 128400, unit: "USD" }] },
        expected: "Revenue",
      },
      {
        id: "timeline",
        component: { name: "Timeline", version: "1.0" },
        props: { entries: [{ label: "Contract sent", timestamp: "2026-08-09" }] },
        expected: "Contract sent",
      },
      {
        id: "comparison",
        component: { name: "Comparison", version: "1.0" },
        props: {
          options: [{ id: "pro", label: "Pro", recommended: true }],
          criteria: [{ id: "cost", label: "Cost" }],
          cells: [{ option: "pro", criterion: "cost", value: "$75" }],
        },
        expected: "recommended",
      },
      {
        id: "breakdown",
        component: { name: "Breakdown", version: "1.0" },
        props: { segments: [{ label: "Payroll", value: 54000 }], currency: "USD" },
        expected: "Payroll",
      },
      {
        id: "gauge",
        component: { name: "Gauge", version: "1.0" },
        props: { label: "Quota", value: 72, max: 100, unit: "%" },
        expected: "Quota",
      },
    ] as const;

    for (const sample of samples) {
      const artifact = createSurfaceArtifact({
        id: sample.id,
        component: sample.component,
        props: sample.props,
        target: { channel: "github", surface: "comment" },
        audience: ["user:1"],
        classification: "internal",
      });
      const payload = githubCommentRenderer.render(artifact, { destination: "issue:1" });
      expect(payload.kind).toBe("comment");
      if (payload.kind === "comment") expect(payload.body).toContain(sample.expected);
    }
  });
});
