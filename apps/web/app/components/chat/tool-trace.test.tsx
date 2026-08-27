import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ToolTrace } from "~/components/chat/tool-trace";
import { LOADER_LABELS } from "~/components/ui/loading-state";
import type { TimelinePart } from "~/lib/chat/types";

type ToolPart = Extract<TimelinePart, { kind: "tool" }>;

function call(overrides: Partial<ToolPart> & { toolCallId: string; toolName: string }): ToolPart {
  return {
    kind: "tool",
    args: {},
    status: "done",
    outcome: "ok",
    ...overrides,
  };
}

describe("ToolTrace", () => {
  it("names the call in flight in the present tense, and settled calls in the past", () => {
    render(
      <ToolTrace
        onApprove={() => undefined}
        foldable={false}
        pending
        parts={[
          call({ toolCallId: "a", toolName: "list_agents" }),
          call({ toolCallId: "b", toolName: "search_docs", status: "running" }),
        ]}
      />
    );

    expect(screen.getByText("Listed agents")).toBeInTheDocument();
    // Anchor on the Tool name chip so this reads the step row, not the trace header above it.
    expect(screen.getByText("search_docs").closest(".tf-trace-row")).toHaveTextContent(
      "Searching docs"
    );
    expect(screen.queryByText("Searched docs")).toBeNull();
  });

  it("headlines the trace with the call actually running", () => {
    render(
      <ToolTrace
        onApprove={() => undefined}
        foldable={false}
        pending
        parts={[
          call({ toolCallId: "a", toolName: "list_agents" }),
          call({ toolCallId: "b", toolName: "read_page", status: "running" }),
        ]}
      />
    );

    // The header is a button, so the accessible name carries the label.
    expect(screen.getByRole("button", { name: /Reading page/ })).toBeInTheDocument();
  });

  it("falls back to the settled label when the verb is not one it wrote", () => {
    render(
      <ToolTrace
        onApprove={() => undefined}
        foldable={false}
        pending
        parts={[
          call({
            toolCallId: "a",
            toolName: "weird_thing",
            status: "running",
            meta: { summary: "Doing something unusual" },
          }),
        ]}
      />
    );

    // No invented conjugation: a server-supplied summary is shown as authored.
    expect(screen.getAllByText("Doing something unusual").length).toBeGreaterThan(0);
  });

  it("expands the running step and folds the settled ones", () => {
    render(
      <ToolTrace
        onApprove={() => undefined}
        foldable={false}
        pending
        parts={[
          call({ toolCallId: "a", toolName: "list_agents", result: [1, 2, 3] }),
          call({
            toolCallId: "b",
            toolName: "read_page",
            status: "running",
            meta: { durationMs: 40 },
          }),
        ]}
      />
    );

    const settled = screen.getByText("Listed agents").closest("button");
    const running = screen.getAllByText("Reading page").at(-1)?.closest("button");
    expect(settled).toHaveAttribute("aria-expanded", "false");
    expect(running).toHaveAttribute("aria-expanded", "true");
  });

  it("holds a failed step open, because the error is the evidence", () => {
    render(
      <ToolTrace
        onApprove={() => undefined}
        foldable={false}
        pending
        parts={[
          call({
            toolCallId: "a",
            toolName: "send_slack_message",
            outcome: "error",
            meta: { errorCode: "channel_not_found" },
          }),
          call({ toolCallId: "b", toolName: "read_page", status: "running" }),
        ]}
      />
    );

    expect(screen.getByText("Sent Slack message").closest("button")).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    expect(screen.getByText("channel_not_found")).toBeInTheDocument();
  });

  it("links a missing Credential to its setup page", () => {
    const Stub = createRemixStub([
      {
        path: "/",
        Component: () => (
          <ToolTrace
            onApprove={() => undefined}
            foldable={false}
            pending={false}
            parts={[
              call({
                toolCallId: "a",
                toolName: "api_request",
                outcome: "error",
                meta: {
                  errorCode: "credential_required",
                  connectUrl: "/business/secrets?required=EXAMPLE_TOKEN",
                },
              }),
            ]}
          />
        ),
      },
    ]);
    render(<Stub />);
    expect(screen.getByRole("link", { name: "Add the required Credential →" })).toHaveAttribute(
      "href",
      "/business/secrets?required=EXAMPLE_TOKEN"
    );
  });

  it("reports progress the reader can check against the rows", () => {
    render(
      <ToolTrace
        onApprove={() => undefined}
        foldable={false}
        pending
        parts={[
          call({ toolCallId: "a", toolName: "list_agents" }),
          call({ toolCallId: "b", toolName: "read_page", status: "running" }),
          call({ toolCallId: "c", toolName: "search_docs", status: "running" }),
        ]}
      />
    );

    expect(screen.getByText("1 of 3 finished")).toBeInTheDocument();
  });

  it("shows a live edge between calls, when no Tool is in flight yet", () => {
    render(
      <ToolTrace
        onApprove={() => undefined}
        foldable={false}
        pending
        parts={[
          call({ toolCallId: "a", toolName: "list_agents" }),
          call({ toolCallId: "b", toolName: "list_skills" }),
        ]}
      />
    );

    // Every call has landed, but the Turn has not — a column of ticks would read as finished.
    // The fallback label is drawn at random from LOADER_LABELS, so match membership, not a literal.
    const label = LOADER_LABELS.find((word) => screen.queryByText(word) !== null);
    expect(label).toBeDefined();
  });

  it("folds to its header once the run is no longer the live edge", () => {
    render(
      <ToolTrace
        onApprove={() => undefined}
        foldable
        pending={false}
        parts={[
          call({ toolCallId: "a", toolName: "list_agents" }),
          call({ toolCallId: "b", toolName: "list_skills" }),
        ]}
      />
    );

    expect(screen.getByRole("button", { name: /Ran 2 tools/ })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    for (const word of LOADER_LABELS) {
      expect(screen.queryByText(word)).toBeNull();
    }
  });

  it("counts the failures in its settled header, which is what lets a failed run fold", () => {
    render(
      <ToolTrace
        onApprove={() => undefined}
        foldable
        pending={false}
        parts={[
          call({ toolCallId: "a", toolName: "list_agents" }),
          call({ toolCallId: "b", toolName: "list_skills" }),
          call({
            toolCallId: "c",
            toolName: "send_slack_message",
            outcome: "error",
            meta: { errorCode: "channel_not_found" },
          }),
        ]}
      />
    );

    expect(screen.getByRole("button", { name: /Ran 3 tools · 1 failed/ })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
  });

  it("says nothing about failures when there were none", () => {
    render(
      <ToolTrace
        onApprove={() => undefined}
        foldable
        pending={false}
        parts={[
          call({ toolCallId: "a", toolName: "list_agents" }),
          call({ toolCallId: "b", toolName: "list_skills" }),
          call({ toolCallId: "c", toolName: "list_resource_types" }),
        ]}
      />
    );

    expect(screen.getByRole("button", { name: /Ran 3 tools$/ })).toBeInTheDocument();
  });

  it("marks a step whose Tool can write", () => {
    // Write capability is a standing property of the Tool, so it belongs on the face of the step
    // rather than behind its disclosure — the reader should not have to open a row to learn it.
    render(
      <ToolTrace
        onApprove={() => undefined}
        foldable={false}
        pending={false}
        parts={[
          call({ toolCallId: "a", toolName: "list_agents" }),
          call({ toolCallId: "b", toolName: "write_thing", meta: { mutating: true } }),
        ]}
      />
    );

    const marker = screen.getByLabelText("This tool can write");
    expect(marker.closest(".tf-trace-row")).toHaveTextContent("write_thing");
  });

  it("exposes the verbatim Input and Output behind a step", async () => {
    const user = userEvent.setup();
    render(
      <ToolTrace
        onApprove={() => undefined}
        foldable={false}
        pending={false}
        parts={[
          call({ toolCallId: "a", toolName: "write_thing", args: { x: 1 }, result: { ok: true } }),
        ]}
      />
    );

    const step = screen.getByRole("button", { name: /write_thing/ });
    expect(step).toHaveAttribute("aria-expanded", "false");

    await user.click(step);

    expect(screen.getByText("Input")).toBeInTheDocument();
    expect(screen.getByText("Output")).toBeInTheDocument();
  });
  it("puts an approval on the rail in the open, never behind a step's disclosure", async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    render(
      <ToolTrace
        onApprove={onApprove}
        foldable={false}
        pending
        parts={[
          call({ toolCallId: "a", toolName: "search_docs" }),
          {
            ...call({ toolCallId: "b", toolName: "send_email" }),
            status: "running",
            outcome: undefined,
            approval: { approvalId: "appr_1", status: "pending" },
          },
        ]}
      />
    );

    const approve = screen.getByRole("button", { name: "Approve" });

    // A question the reader has to click to find is a question they will miss: the card is a
    // sibling of the steps, not part of one, so no disclosure can swallow it.
    expect(approve.closest("[inert]")).toBeNull();
    expect(approve.closest(".tf-trace-row")).toBeNull();

    await user.click(approve);
    expect(onApprove).toHaveBeenCalledWith("appr_1", "approve");
  });
});
