import { createSurfaceArtifact } from "@tulipfarm/surface";
import { describe, expect, it } from "vitest";
import { telegramRenderer } from "./index";

describe("telegramRenderer", () => {
  it("uses short callback handles", () => {
    const artifact = createSurfaceArtifact({
      id: "choice",
      component: { name: "Choices", version: "1.0" },
      props: {
        question: "Choose",
        choices: [{ label: "One", value: "one" }],
        action: { event: "choice.select" },
      },
      target: { channel: "telegram", surface: "message" },
      audience: ["user:1"],
      classification: "internal",
    });
    const payload = telegramRenderer.render(artifact, {
      destination: "1",
      actionHandleFor: () => "h_123",
    });
    expect(payload.reply_markup?.inline_keyboard[0]?.[0]?.callback_data).toBe("h_123");
  });

  it("renders data-display components as escaped HTML text", () => {
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
        target: { channel: "telegram", surface: "message" },
        audience: ["user:1"],
        classification: "internal",
      });
      const payload = telegramRenderer.render(artifact, { destination: "1" });
      expect(payload.text).toContain(sample.expected);
    }
  });
});
