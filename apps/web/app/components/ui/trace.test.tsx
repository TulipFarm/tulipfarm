import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { Trace, TraceNote, TraceStep } from "./trace";

function Sample({ working, keepOpen }: { working: boolean; keepOpen?: boolean }) {
  return (
    <Trace
      activeLabel="Thinking"
      settledLabel="Thought process"
      working={working}
      keepOpen={keepOpen}
    >
      <TraceNote>Two Agents already write to this type.</TraceNote>
    </Trace>
  );
}

test("opens itself while the work is in flight and folds once it settles", () => {
  const { rerender } = render(<Sample working />);

  expect(screen.getByRole("button", { name: /Thinking/ })).toHaveAttribute("aria-expanded", "true");

  rerender(<Sample working={false} />);
  expect(screen.getByRole("button", { name: /Thought process/ })).toHaveAttribute(
    "aria-expanded",
    "false"
  );
});

test("hands control to the reader for good once they toggle it", async () => {
  const user = userEvent.setup();
  const { rerender } = render(<Sample working />);

  await user.click(screen.getByRole("button", { name: /Thinking/ }));
  expect(screen.getByRole("button", { name: /Thinking/ })).toHaveAttribute(
    "aria-expanded",
    "false"
  );

  // Settling must not reopen what the reader closed, nor reclose what they opened.
  rerender(<Sample working={false} />);
  expect(screen.getByRole("button", { name: /Thought process/ })).toHaveAttribute(
    "aria-expanded",
    "false"
  );
});

test("stays open after settling when it still holds something to read", () => {
  render(<Sample working={false} keepOpen />);

  expect(screen.getByRole("button", { name: /Thought process/ })).toHaveAttribute(
    "aria-expanded",
    "true"
  );
});

test("takes a collapsed trace out of the tab order rather than only hiding it", () => {
  const { container } = render(<Sample working={false} />);
  const body = container.querySelector("[inert]");

  expect(body).not.toBeNull();
  expect(body).toHaveTextContent("Two Agents already write to this type.");
});

test("announces one stable line and keeps the ticking value out of it", () => {
  render(
    <Trace activeLabel="Thinking" settledLabel="Thought" working durationMs={4_200}>
      <TraceNote>Reasoning.</TraceNote>
    </Trace>
  );

  expect(screen.getByRole("status")).toHaveTextContent("Thinking");
  expect(screen.getByRole("status")).not.toHaveTextContent("4.2s");
  expect(screen.getByText("4.2s")).toHaveAttribute("aria-hidden", "true");
});

test("stays quiet about duration until it has actually measured one", () => {
  render(
    <Trace activeLabel="Thinking" settledLabel="Thought" working={false}>
      <TraceNote>Restored from history.</TraceNote>
    </Trace>
  );

  // A restored conversation never worked in front of the reader, so claiming `0.0s` would be a lie.
  expect(screen.queryByText(/^\d/)).not.toBeInTheDocument();
});

test("expands the step in flight and collapses the ones that finished", () => {
  render(
    <Trace activeLabel="Working" settledLabel="Worked" working keepOpen>
      <TraceStep status="done" label="Read the invoices" detail={<span>14 records</span>} />
      <TraceStep
        status="running"
        label="Drafting the reminder"
        detail={<span>Matching tone</span>}
      />
    </Trace>
  );

  expect(screen.getByRole("button", { name: /Read the invoices/ })).toHaveAttribute(
    "aria-expanded",
    "false"
  );
  expect(screen.getByRole("button", { name: /Drafting the reminder/ })).toHaveAttribute(
    "aria-expanded",
    "true"
  );
});

test("holds a failed step open, because the error is the evidence", () => {
  render(
    <Trace activeLabel="Working" settledLabel="Stopped" working={false} keepOpen>
      <TraceStep
        status="error"
        label="Posted to the ops channel"
        detail={<span>channel_not_found</span>}
      />
    </Trace>
  );

  expect(screen.getByRole("button", { name: /Posted to the ops channel/ })).toHaveAttribute(
    "aria-expanded",
    "true"
  );
});

test("does not make a step with nothing to reveal into a control", () => {
  render(
    <Trace activeLabel="Working" settledLabel="Worked" working keepOpen>
      <TraceStep status="pending" label="Send to each owner" />
    </Trace>
  );

  expect(screen.queryByRole("button", { name: /Send to each owner/ })).not.toBeInTheDocument();
  expect(screen.getByText("Send to each owner")).toBeInTheDocument();
});
