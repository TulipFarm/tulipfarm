import { act, render, screen } from "@testing-library/react";
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
        // The panes belong to the sealed record; a live Turn is narrated instead.
        { type: "finish", data: { reason: "stop" } },
      ])
    );
    expect(screen.getByText("write_thing")).toBeInTheDocument();
    const step = screen.getByRole("button", { name: /write_thing/i });
    // Nothing is disclosed until it is asked for; the panes live behind the step's own toggle.
    expect(step).toHaveAttribute("aria-expanded", "false");

    await user.click(step);

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
        // The panes belong to the settled record; a call still in flight is narrated instead.
        {
          type: "tool-result",
          data: { toolCallId: "c1", toolName: "github_issue_comment", result: { ok: true } },
        },
        { type: "finish", data: { reason: "stop" } },
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
    expect(screen.getByText("Needs your approval")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Approve" }));
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
    expect(screen.getByText("Denied")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
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

  it("narrates an in-flight tool call in the present tense, not as the settled record", () => {
    // The running state was unreachable in the real transcript because the streaming flag was
    // gated on `part.kind === "text"`, so every live tool call rendered as blocked. It now renders
    // as a Trace: the reader follows along while it runs, and gets the record once it settles.
    const state = fold(
      [{ type: "tool-call", data: { toolCallId: "c1", toolName: "write_thing", args: { x: 1 } } }],
      "hi"
    );
    const { container } = render(
      <Transcript messages={state.messages} status={state.status} onApprove={vi.fn()} />
    );

    expect(state.status).toBe("streaming");
    // Present tense while it runs — "Wrote thing" beside a spinner would claim it had finished.
    expect(screen.getAllByText("Writing thing").length).toBeGreaterThan(0);
    // Narration, not evidence: the bordered record block is not drawn yet.
    expect(container.querySelector(".rounded-lg.border-run-border")).toBeNull();
  });

  it("shows a loading state, not a Tool row, while a presentation Tool is in flight", () => {
    // `present` draws the answer; naming it as a step would tell the reader the assistant had
    // called a tool to do the one thing they can already see it doing.
    const state = fold(
      [{ type: "tool-call", data: { toolCallId: "p1", toolName: "present", args: {} } }],
      "hi"
    );
    const { container } = render(
      <Transcript messages={state.messages} status={state.status} onApprove={vi.fn()} />
    );

    expect(container.querySelector(".tf-trace-row")).toBeNull();
    expect(screen.queryByText("present")).toBeNull();
    expect(screen.getAllByText("Rendering").length).toBeGreaterThan(0);
  });

  it("keeps narrating between calls, while the Turn is still live", () => {
    // A platform Tool returns in ~20ms and the model then thinks for seconds. Gating narration on
    // a call being mid-flight handed the reader the finished record while the Turn was still going.
    const state = fold(
      [
        { type: "tool-call", data: { toolCallId: "c1", toolName: "list_agents", args: {} } },
        { type: "tool-result", data: { toolCallId: "c1", toolName: "list_agents", result: [] } },
      ],
      "hi"
    );
    const { container } = render(
      <Transcript messages={state.messages} status={state.status} onApprove={vi.fn()} />
    );

    expect(state.status).toBe("streaming");
    expect(container.querySelector(".rounded-lg.border-run-border")).toBeNull();
    expect(container.querySelector(".tf-trace-row")).not.toBeNull();
  });

  it("keeps a settled tool run in the trace instead of handing it back to a bordered record", () => {
    const state = fold([
      { type: "tool-call", data: { toolCallId: "c1", toolName: "write_thing", args: { x: 1 } } },
      {
        type: "tool-result",
        data: { toolCallId: "c1", toolName: "write_thing", result: { ok: true } },
      },
      { type: "finish", data: { reason: "stop" } },
    ]);
    const { container } = render(
      <Transcript messages={state.messages} status={state.status} onApprove={vi.fn()} />
    );

    expect(screen.getByText("Wrote thing")).toBeInTheDocument();
    expect(screen.queryByText("Writing thing")).toBeNull();
    // The box is gone for good; only a run awaiting a decision still gets one.
    expect(container.querySelector(".rounded-lg.border-run-border")).toBeNull();
    expect(container.querySelector(".tf-trace-row")).not.toBeNull();
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

    const header = screen.getByRole("button", { name: /Ran 3 tools/ });
    // The individual rows are folded away until asked for.
    expect(header).toHaveAttribute("aria-expanded", "false");

    await user.click(header);

    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("search_a")).toBeInTheDocument();
    expect(screen.getByText("search_c")).toBeInTheDocument();
  });

  it("folds a run that failed, but names the failure count on the line that survives", async () => {
    const user = userEvent.setup();
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

    // Folding a failure is only honest because the header reports it — the reader loses a click,
    // never the fact that something went wrong.
    const header = screen.getByRole("button", { name: /Ran 4 tools · 1 failed/ });
    expect(header).toHaveAttribute("aria-expanded", "false");

    await user.click(header);

    expect(screen.getByText("write_thing")).toBeInTheDocument();
    expect(screen.getByText("search_a")).toBeInTheDocument();
    // The failed step opens itself, so the error code is there without a second click.
    expect(screen.getByText("tool_failed")).toBeInTheDocument();
  });
});

describe("an attachment the reader can no longer open", () => {
  const withParts = (parts: ChatState["messages"][number]["parts"]): ChatState => ({
    ...initialChatState,
    messages: [{ id: "m1", role: "user", parts, sealed: true }],
  });

  it("names what was removed instead of leaving a broken image", () => {
    render(
      <Transcript
        messages={
          withParts([
            { kind: "text", text: "what is this?" },
            { kind: "file-unavailable", fileId: "f1", name: "budget.pdf" },
          ]).messages
        }
        status="idle"
        onApprove={vi.fn()}
      />
    );

    expect(screen.getByText("budget.pdf")).toBeInTheDocument();
    expect(screen.getByText("removed")).toBeInTheDocument();
  });

  it("renders a removed attachment alongside one that is still there", () => {
    render(
      <Transcript
        messages={
          withParts([
            { kind: "file", fileId: "f1", mediaType: "application/pdf", name: "here.pdf" },
            { kind: "file-unavailable", fileId: "f2", name: "gone.pdf" },
          ]).messages
        }
        status="idle"
        onApprove={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Download here.pdf" })).toBeInTheDocument();
    expect(screen.getByText("gone.pdf")).toBeInTheDocument();
  });
});

describe("Transcript auto-scroll stays inside its own scroll container", () => {
  // `scrollIntoView` walks every scrollable ancestor, so the shell's <main> and the document
  // itself get dragged down with the transcript (#69). Writing `scrollTop` cannot leave the
  // container, so the guard is that the transcript never reaches for `scrollIntoView` again.
  function trackScrolling() {
    const intoView = vi.fn();
    Element.prototype.scrollIntoView = intoView;
    const scrolled: number[] = [];
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true,
      get: () => 0,
      set: (value: number) => void scrolled.push(value),
    });
    return {
      intoView,
      scrolled,
      restore: () => {
        if (descriptor) Object.defineProperty(Element.prototype, "scrollTop", descriptor);
      },
    };
  }

  function flushFrames() {
    return act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
  }

  it("pins to the bottom without scrolling any ancestor while a response is loading", async () => {
    const tracked = trackScrolling();
    try {
      const state = fold([], "hello");
      expect(state.status).toBe("submitted");
      render(<Transcript messages={state.messages} status={state.status} onApprove={vi.fn()} />);
      await flushFrames();

      expect(tracked.intoView).not.toHaveBeenCalled();
      expect(tracked.scrolled.length).toBeGreaterThan(0);
    } finally {
      tracked.restore();
    }
  });

  it("pins to the bottom without scrolling any ancestor while text streams in", async () => {
    const tracked = trackScrolling();
    try {
      render(
        <Transcript
          messages={fold([{ type: "text", data: { delta: "streaming" } }], "hi").messages}
          status="streaming"
          onApprove={vi.fn()}
        />
      );
      await flushFrames();

      expect(tracked.intoView).not.toHaveBeenCalled();
      expect(tracked.scrolled.length).toBeGreaterThan(0);
    } finally {
      tracked.restore();
    }
  });
});
