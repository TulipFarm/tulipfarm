import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Transcript } from "~/components/chat/transcript";
import { appendUserMessage, chatReducer, initialChatState } from "~/lib/chat/reducer";
import type { ChatEvent, ChatState, ChatTurnOptions } from "~/lib/chat/types";

// jsdom has no layout engine; the transcript's auto-scroll calls scrollIntoView.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

// Build renderable state by folding synthetic SSE events through the real reducer — exactly how the
// live stream would, but deterministic. This drives every "renders X from its SSE event" check.
function fold(events: ChatEvent[], user?: string, options?: ChatTurnOptions): ChatState {
  let state = user ? appendUserMessage(initialChatState, user, options) : initialChatState;
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

  it("a tool call and its result, separated into Input and Output panes", async () => {
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
    expect(screen.getByText("write_thing")).toBeInTheDocument();
    // Collapsed: the panes and their contents are hidden until the row is expanded.
    expect(screen.queryByText("Input")).toBeNull();
    expect(screen.queryByText("Output")).toBeNull();

    await user.click(screen.getByRole("button", { name: /write_thing/i }));

    // Input and Output are labelled and distinct — the old row printed the same JSON twice.
    expect(screen.getByText("Input")).toBeInTheDocument();
    expect(screen.getByText("Output")).toBeInTheDocument();
    expect(screen.getByText('"x"')).toBeInTheDocument();
    expect(screen.getByText('"ok"')).toBeInTheDocument();
    expect(screen.getByText("true")).toBeInTheDocument();
  });

  it("shows a Tool's redacted preview and names what was withheld", async () => {
    const user = userEvent.setup();
    renderTranscript(
      fold([
        {
          type: "tool-call",
          data: {
            toolCallId: "c1",
            toolName: "github_issue_comment",
            args: { argsDigest: "sha256:abc" },
            preview: {
              json: JSON.stringify({ repo: "maddhruv/tulipfarm", token: "[redacted]" }),
              redactedPaths: ["token"],
            },
            meta: { tier: "integration", mutating: true, durationMs: 1240 },
          },
        },
      ])
    );

    await user.click(screen.getByRole("button", { name: /github_issue_comment/i }));

    expect(screen.getByText('"maddhruv/tulipfarm"')).toBeInTheDocument();
    // A withheld field is shown as an explicit gap, never silently dropped.
    expect(screen.getByText("redacted")).toBeInTheDocument();
    expect(screen.getByText("1 field withheld")).toBeInTheDocument();
    expect(screen.getByLabelText("This tool can write")).toBeInTheDocument();
  });

  it("a reasoning panel (expandable)", async () => {
    const user = userEvent.setup();
    renderTranscript(
      fold([
        { type: "reasoning", data: { delta: "weighing options" } },
        { type: "finish", data: { reason: "stop" } },
      ])
    );
    const toggle = screen.getByRole("button", { name: /thought process/i });
    expect(toggle).toBeInTheDocument();
    await user.click(toggle);
    expect(screen.getByText("weighing options")).toBeInTheDocument();
  });

  it("labels reasoning as in progress while the turn is still live", () => {
    renderTranscript(fold([{ type: "reasoning", data: { delta: "weighing options" } }]));
    expect(screen.getByRole("button", { name: /thinking/i })).toBeInTheDocument();
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
    expect(screen.getByText("Onboard lead")).toBeInTheDocument();
    // The step rail reports progress as a count, replacing the old `[ ] [x]` ASCII marks.
    expect(screen.getByText("1/2")).toBeInTheDocument();
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

    // Both the user turn and the assistant reply expose a copy button.
    expect(screen.getAllByRole("button", { name: "copy" }).length).toBeGreaterThanOrEqual(1);
    await user.click(screen.getByRole("button", { name: "regenerate" }));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  it("hides the assistant action bar while a turn is still streaming", () => {
    const state = fold([{ type: "text", data: { delta: "typing" } }], "hi");
    render(
      <Transcript
        messages={state.messages}
        status={state.status}
        onApprove={vi.fn()}
        onRegenerate={vi.fn()}
      />
    );
    // The user turn keeps its copy/edit toolbar, but the assistant controls stay hidden until sealed.
    expect(screen.queryByRole("button", { name: "regenerate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Bad response" })).toBeNull();
  });

  it("shows an in-flight tool call as running, not skipped", () => {
    // The running state was unreachable in the real transcript because the streaming flag was
    // gated on `part.kind === "text"`, so every live tool call rendered as blocked.
    const state = fold(
      [{ type: "tool-call", data: { toolCallId: "c1", toolName: "write_thing", args: { x: 1 } } }],
      "hi"
    );
    const { container } = render(
      <Transcript messages={state.messages} status={state.status} onApprove={vi.fn()} />
    );

    expect(state.status).toBe("streaming");
    expect(container.querySelector(".run-rail-active")).not.toBeNull();
  });

  // A sealed assistant reply with its server id attached — the prerequisite for rendering thumbs.
  function ratedReply() {
    const state = fold(
      [
        { type: "text", data: { delta: "Hello there" } },
        { type: "finish", data: { reason: "stop" } },
      ],
      "hi"
    );
    state.messages[1].serverId = "m1";
    return state;
  }

  it("records a thumbs vote via onFeedback, decoupled from regenerate", async () => {
    const user = userEvent.setup();
    const onRegenerate = vi.fn();
    const onFeedback = vi.fn();
    const state = ratedReply();
    render(
      <Transcript
        messages={state.messages}
        status={state.status}
        onApprove={vi.fn()}
        onRegenerate={onRegenerate}
        onFeedback={onFeedback}
      />
    );
    await user.click(screen.getByRole("button", { name: "Good response" }));
    expect(onFeedback).toHaveBeenLastCalledWith("m1", "up");
    await user.click(screen.getByRole("button", { name: "Bad response" }));
    expect(onFeedback).toHaveBeenLastCalledWith("m1", "down");
    // Voting never re-runs the turn — regenerate is its own separate button now.
    expect(onRegenerate).not.toHaveBeenCalled();
  });

  it("opens an optional note on down-vote and submits it via onFeedback", async () => {
    const user = userEvent.setup();
    const onFeedback = vi.fn();
    const state = ratedReply();
    render(
      <Transcript
        messages={state.messages}
        status={state.status}
        onApprove={vi.fn()}
        onFeedback={onFeedback}
      />
    );
    await user.click(screen.getByRole("button", { name: "Bad response" }));
    await user.type(screen.getByRole("textbox", { name: "Feedback note" }), "too long{Enter}");
    expect(onFeedback).toHaveBeenLastCalledWith("m1", "down", "too long");
  });

  it("shows no thumbs until the reply has a server id", () => {
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
        onFeedback={vi.fn()}
      />
    );
    expect(screen.queryByRole("button", { name: "Good response" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Bad response" })).toBeNull();
  });

  it("shows a quiet model receipt on a sealed assistant reply", () => {
    const state = fold(
      [
        { type: "text", data: { delta: "Hello there" } },
        {
          type: "finish",
          data: {
            reason: "stop",
            receipt: {
              modelId: "claude-sonnet-5",
              effortPreset: "auto",
              modelCallLatencyMs: 1234,
            },
          },
        },
      ],
      "hi"
    );

    renderTranscript(state);

    expect(screen.getByText("Answered by")).toBeInTheDocument();
    expect(screen.getByText("claude-sonnet-5")).toBeInTheDocument();
    expect(screen.getByText("· Auto effort")).toBeInTheDocument();
    expect(screen.getByText("· model call 1.2 s")).toBeInTheDocument();
  });

  it("renders no receipt for older sealed replies without receipt fields", () => {
    const state = fold(
      [
        { type: "text", data: { delta: "Hello there" } },
        { type: "finish", data: { reason: "stop" } },
      ],
      "hi"
    );

    renderTranscript(state);

    expect(screen.queryByText("Answered by")).toBeNull();
  });

  it("offers Try harder with the next effort preset on a completed assistant reply", async () => {
    const user = userEvent.setup();
    const onTryHarder = vi.fn();
    const state = fold(
      [
        { type: "text", data: { delta: "Hello there" } },
        {
          type: "finish",
          data: {
            reason: "stop",
            receipt: {
              modelId: "claude-sonnet-5",
              effortPreset: "auto",
              effortApplied: "balanced",
              modelCallLatencyMs: 1234,
            },
          },
        },
      ],
      "hi",
      {
        model: "auto",
        agentId: "agent-1",
        skills: ["triage"],
        resources: ["ticket"],
        knowledgePages: ["page-1"],
      }
    );
    const assistantId = state.messages.find((message) => message.role === "assistant")?.id;

    render(
      <Transcript
        messages={state.messages}
        status={state.status}
        onApprove={vi.fn()}
        onTryHarder={onTryHarder}
      />
    );

    await user.click(screen.getByRole("button", { name: "Try harder with Thorough effort" }));
    expect(onTryHarder).toHaveBeenCalledWith(assistantId, "thorough");
  });

  it("shows what Auto resolved to, so the participant sees the choice made for them", () => {
    const state = fold(
      [
        { type: "text", data: { delta: "Hello there" } },
        {
          type: "finish",
          data: {
            reason: "stop",
            receipt: {
              modelId: "claude-haiku-5",
              effortPreset: "auto",
              effortApplied: "fast",
              modelCallLatencyMs: 200,
            },
          },
        },
      ],
      "hi",
      { model: "auto" }
    );

    render(<Transcript messages={state.messages} status={state.status} onApprove={vi.fn()} />);

    expect(screen.getByText("· Auto → Fast effort")).toBeInTheDocument();
  });

  it("offers no Try harder when Auto reported no rung, rather than guessing one", () => {
    const state = fold(
      [
        { type: "text", data: { delta: "Hello there" } },
        {
          type: "finish",
          data: {
            reason: "stop",
            receipt: {
              modelId: "claude-sonnet-5",
              effortPreset: "auto",
              modelCallLatencyMs: 1234,
            },
          },
        },
      ],
      "hi",
      { model: "auto" }
    );

    render(
      <Transcript
        messages={state.messages}
        status={state.status}
        onApprove={vi.fn()}
        onTryHarder={vi.fn()}
      />
    );

    expect(screen.queryByRole("button", { name: /Try harder/ })).not.toBeInTheDocument();
  });

  it("does not offer Try harder at the top of the ladder", () => {
    const state = fold(
      [
        { type: "text", data: { delta: "Hello there" } },
        {
          type: "finish",
          data: {
            reason: "stop",
            receipt: {
              modelId: "claude-sonnet-5",
              effortPreset: "thorough",
              modelCallLatencyMs: 1234,
            },
          },
        },
      ],
      "hi",
      { model: "thorough" }
    );

    render(
      <Transcript
        messages={state.messages}
        status={state.status}
        onApprove={vi.fn()}
        onTryHarder={vi.fn()}
      />
    );

    expect(screen.queryByRole("button", { name: /Try harder/i })).toBeNull();
  });

  it("keeps Try harder unavailable while a turn is streaming", () => {
    const state = fold(
      [
        { type: "text", data: { delta: "Hello there" } },
        { type: "finish", data: { reason: "stop" } },
      ],
      "hi",
      { model: "fast" }
    );

    render(
      <Transcript
        messages={state.messages}
        status="streaming"
        onApprove={vi.fn()}
        onTryHarder={vi.fn()}
      />
    );

    expect(screen.queryByRole("button", { name: /Try harder/i })).toBeNull();
  });
});

describe("Transcript folds a long run of tool calls", () => {
  // Three settled successes in a row, on a finished turn.
  const clusterEvents: ChatEvent[] = ["a", "b", "c"].flatMap((id): ChatEvent[] => [
    { type: "tool-call", data: { toolCallId: id, toolName: `search_${id}`, args: {} } },
    {
      type: "tool-result",
      data: { toolCallId: id, toolName: `search_${id}`, result: { success: true } },
    },
  ]);

  it("collapses them into one 'Ran N tools' row and expands back to the individual calls", async () => {
    const user = userEvent.setup();
    renderTranscript(fold([...clusterEvents, { type: "finish", data: { reason: "completed" } }]));

    expect(screen.getByText("Ran 3 tools")).toBeInTheDocument();
    // The individual rows are folded away until asked for.
    expect(screen.queryByText("search_a")).toBeNull();

    await user.click(screen.getByRole("button", { name: /Ran 3 tools/ }));

    expect(screen.getByText("search_a")).toBeInTheDocument();
    expect(screen.getByText("search_c")).toBeInTheDocument();
  });

  it("keeps every row on screen when the run contains a failure", () => {
    renderTranscript(
      fold([
        ...clusterEvents,
        { type: "tool-call", data: { toolCallId: "d", toolName: "write_thing", args: {} } },
        {
          type: "tool-result",
          data: {
            toolCallId: "d",
            toolName: "write_thing",
            result: { status: "error" },
            meta: { errorCode: "tool_failed" },
          },
        },
        { type: "finish", data: { reason: "completed" } },
      ])
    );

    // A failure anywhere in the run keeps every row on screen, fold header included.
    expect(screen.queryByText(/Ran \d+ tools/)).toBeNull();
    expect(screen.getByText("write_thing")).toBeInTheDocument();
    expect(screen.getByText("search_a")).toBeInTheDocument();
    expect(screen.getByText("tool_failed")).toBeInTheDocument();
  });
});
