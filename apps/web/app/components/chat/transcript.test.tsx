import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Transcript } from "~/components/chat/transcript";
import { appendUserMessage, chatReducer, initialChatState } from "~/lib/chat/reducer";
import type { ChatEvent, ChatState } from "~/lib/chat/types";

// jsdom has no layout engine; the transcript's auto-scroll calls scrollIntoView.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

// Build renderable state by folding synthetic SSE events through the real reducer — exactly how the
// live stream would, but deterministic. This drives every "renders X from its SSE event" check.
function fold(events: ChatEvent[], user?: string): ChatState {
  let state = user ? appendUserMessage(initialChatState, user) : initialChatState;
  for (const e of events) state = chatReducer(state, e);
  return state;
}

function renderTranscript(state: ChatState) {
  const onApprove = vi.fn();
  render(<Transcript messages={state.messages} status={state.status} onApprove={onApprove} />);
  return { onApprove };
}

const future = (): string => new Date(Date.now() + 60_000).toISOString();

describe("Transcript renders each part from its SSE event", () => {
  it("streaming text", () => {
    renderTranscript(
      fold([
        { type: "text", data: { delta: "Hel" } },
        { type: "text", data: { delta: "lo" } },
      ])
    );
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  it("a tool call and its result (collapsed by default, expandable)", async () => {
    const user = userEvent.setup();
    renderTranscript(
      fold([
        { type: "tool-call", data: { toolCallId: "c1", toolName: "write_thing", args: { x: 1 } } },
        {
          type: "tool-result",
          data: { toolCallId: "c1", toolName: "write_thing", result: { ok: true } },
        },
      ])
    );
    expect(screen.getByText("[tool: write_thing]")).toBeInTheDocument();
    // Collapsed: args + result are hidden until the accordion is expanded.
    expect(screen.queryByText(/"x": 1/)).toBeNull();
    expect(screen.queryByText(/"ok": true/)).toBeNull();
    await user.click(screen.getByRole("button", { name: /tool: write_thing/i }));
    expect(screen.getByText(/"x": 1/)).toBeInTheDocument();
    expect(screen.getByText(/"ok": true/)).toBeInTheDocument();
  });

  it("a reasoning panel (expandable)", async () => {
    const user = userEvent.setup();
    renderTranscript(fold([{ type: "reasoning", data: { delta: "weighing options" } }]));
    const toggle = screen.getByRole("button", { name: /reasoning/i });
    expect(toggle).toBeInTheDocument();
    await user.click(toggle);
    expect(screen.getByText("weighing options")).toBeInTheDocument();
  });

  it("an approval confirmation, and fires the decision", async () => {
    const user = userEvent.setup();
    const { onApprove } = renderTranscript(
      fold([
        { type: "tool-call", data: { toolCallId: "c1", toolName: "write_thing", args: {} } },
        {
          type: "approval-request",
          data: {
            approvalId: "ap1",
            toolCallId: "c1",
            toolName: "write_thing",
            args: {},
            expiresAt: future(),
          },
        },
      ])
    );
    expect(screen.getByText("[approval required]")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "approve" }));
    expect(onApprove).toHaveBeenCalledWith("ap1", "approve");
  });

  it("a resolved (denied) approval distinctly, with no buttons", () => {
    renderTranscript(
      fold([
        { type: "tool-call", data: { toolCallId: "c1", toolName: "write_thing", args: {} } },
        {
          type: "approval-request",
          data: {
            approvalId: "ap1",
            toolCallId: "c1",
            toolName: "write_thing",
            args: {},
            expiresAt: future(),
          },
        },
        {
          type: "approval-resolved",
          data: { approvalId: "ap1", toolCallId: "c1", outcome: "denied" },
        },
      ])
    );
    expect(screen.getByText("denied")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "approve" })).toBeNull();
  });

  it("a routine Plan/Task progress view", () => {
    renderTranscript(
      fold([
        {
          type: "plan",
          data: {
            planId: "p1",
            title: "Onboard lead",
            steps: [
              { id: "s1", label: "Create record", status: "done" },
              { id: "s2", label: "Notify owner", status: "pending" },
            ],
          },
        },
      ])
    );
    expect(screen.getByText("[plan]")).toBeInTheDocument();
    expect(screen.getByText("Onboard lead")).toBeInTheDocument();
    expect(screen.getByText("Create record")).toBeInTheDocument();
    expect(screen.getByText("Notify owner")).toBeInTheDocument();
  });
});

describe("Transcript message actions", () => {
  it("offers copy + regenerate under the last sealed assistant message", async () => {
    const user = userEvent.setup();
    const onRegenerate = vi.fn();
    const state = fold(
      [
        { type: "text", data: { delta: "Hello there" } },
        { type: "finish", data: { reason: "stop" } },
      ],
      "hi"
    );
    render(
      <Transcript
        messages={state.messages}
        status={state.status}
        onApprove={vi.fn()}
        onRegenerate={onRegenerate}
      />
    );

    expect(screen.getByRole("button", { name: "copy" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "regenerate" }));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  it("hides actions while a turn is still streaming", () => {
    const state = fold([{ type: "text", data: { delta: "typing" } }], "hi");
    render(
      <Transcript
        messages={state.messages}
        status={state.status}
        onApprove={vi.fn()}
        onRegenerate={vi.fn()}
      />
    );
    expect(screen.queryByRole("button", { name: "copy" })).toBeNull();
    expect(screen.queryByRole("button", { name: "regenerate" })).toBeNull();
  });
});
