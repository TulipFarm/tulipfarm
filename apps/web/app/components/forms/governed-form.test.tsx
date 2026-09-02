import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GovernedForm } from "@tulipfarm/surface/client";
import { describe, expect, it, vi } from "vitest";
import { GovernedFormView } from "./governed-form";

const form: GovernedForm = {
  id: "expense-request",
  version: "3",
  mode: "standalone",
  schemaRef: "forms/expense-request@3",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["amount"],
    properties: {
      amount: { type: "number", title: "Amount" },
      urgent: { type: "boolean", title: "Urgent" },
      internalCode: { type: "string", title: "Internal code" },
    },
  },
  visibleFields: ["amount", "urgent"],
  audience: ["user:alice"],
  guardrailRevision: "guardrail-7",
  expiresAt: "2026-07-26T01:00:00.000Z",
  triggerId: "trigger-expense",
};

describe("GovernedFormView", () => {
  it("renders only authorized fields and submits through the governed API boundary", async () => {
    const submit = vi.fn(async () => ({
      mode: "standalone" as const,
      eventId: "event-1",
      runId: "run-1",
      outcome: "started" as const,
    }));
    render(<GovernedFormView form={form} submit={submit} />);

    expect(screen.getByLabelText("Amount *")).toBeRequired();
    expect(screen.getByLabelText("Urgent")).toHaveAttribute("type", "checkbox");
    expect(screen.queryByLabelText("Internal code")).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Amount *"), "42");
    await userEvent.click(screen.getByLabelText("Urgent"));
    await userEvent.click(screen.getByRole("button", { name: "Submit form" }));

    expect(submit).toHaveBeenCalledWith(
      "expense-request",
      expect.objectContaining({
        formVersion: "3",
        schemaRef: "forms/expense-request@3",
        guardrailRevision: "guardrail-7",
        data: { amount: 42, urgent: true },
      })
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Run run-1 started");
  });

  it("includes exact RunWait identity outside the response data", async () => {
    const submit = vi.fn(async () => ({
      mode: "run_wait" as const,
      runId: "run-1",
      outcome: "resumed" as const,
    }));
    const runForm: GovernedForm = {
      ...form,
      mode: "run_wait",
      waitId: "wait-1",
      runId: "run-1",
    };
    render(<GovernedFormView form={runForm} resumeToken="one-use" submit={submit} />);
    await userEvent.type(screen.getByLabelText("Amount *"), "12");
    await userEvent.click(screen.getByRole("button", { name: "Submit form" }));

    expect(submit).toHaveBeenCalledWith(
      "expense-request",
      expect.objectContaining({
        runId: "run-1",
        resumeToken: "one-use",
        data: { amount: 12, urgent: false },
      })
    );
  });

  it("supports keyboard submission, announces the result, and moves focus to it", async () => {
    const submit = vi.fn(async () => ({
      mode: "standalone" as const,
      eventId: "event-1",
      runId: "run-1",
      outcome: "started" as const,
    }));
    render(<GovernedFormView form={form} submit={submit} />);

    const region = screen.getByRole("form", { name: "expense-request form" });
    expect(region).toHaveClass("w-full", "max-w-2xl");
    await userEvent.tab();
    expect(screen.getByLabelText("Amount *")).toHaveFocus();
    await userEvent.type(screen.getByLabelText("Amount *"), "42");
    await userEvent.keyboard("{Enter}");

    const status = await screen.findByRole("status");
    expect(status).toHaveFocus();
    expect(status).toHaveTextContent("Run run-1 started");
  });
});
