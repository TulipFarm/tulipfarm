import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TimelinePart } from "~/lib/chat/types";
import { ToolTrace } from "./tool-trace";

type ToolPart = Extract<TimelinePart, { kind: "tool" }>;

function toolPart(overrides: Partial<ToolPart> = {}): ToolPart {
  return {
    kind: "tool",
    toolCallId: "call_1",
    toolName: "github_issue_comment",
    args: { argsDigest: "sha256:4b7e" },
    status: "done",
    outcome: "ok",
    ...overrides,
  };
}

/** One call still draws as a run of one, so this is the step's contract, not the run's. */
function renderStep(part: ToolPart, options?: { pending?: boolean }) {
  return render(
    <ToolTrace
      parts={[part]}
      pending={options?.pending === true}
      foldable={false}
      onApprove={vi.fn()}
    />
  );
}

const step = () => screen.getByRole("button", { name: /github_issue_comment/i });

describe("A Tool step on the trace", () => {
  it("summarises the call in words instead of printing the tool name alone", () => {
    renderStep(
      toolPart({
        argsPreview: { json: JSON.stringify({ repo: "maddhruv/tulipfarm", issue: 412 }) },
      })
    );

    expect(screen.getByText("Commented on maddhruv/tulipfarm#412")).toBeInTheDocument();
    expect(screen.getByText("github_issue_comment")).toBeInTheDocument();
  });

  it("reports a finished call as succeeded even when only a preview came back", () => {
    const { container } = renderStep(toolPart({ resultPreview: { json: '{"ok":true}' } }));

    // A completed call is reported by `status`, not by whether a verbatim result was streamed —
    // on a live stream the verbatim result never arrives.
    expect(container.querySelector(".tf-trace-row .lucide-check")).not.toBeNull();
  });

  it("separates Input from Output and names every withheld field", async () => {
    const user = userEvent.setup();
    renderStep(
      toolPart({
        argsPreview: {
          json: JSON.stringify({ repo: "maddhruv/tulipfarm", token: "[redacted]" }),
          redactedPaths: ["token"],
        },
        resultPreview: { json: JSON.stringify({ success: true }) },
      })
    );

    await user.click(step());

    expect(screen.getByText("Input")).toBeInTheDocument();
    expect(screen.getByText("Output")).toBeInTheDocument();
    expect(screen.getByText("redacted")).toBeInTheDocument();
    expect(screen.getByText("1 field withheld")).toBeInTheDocument();
  });

  it("says how much was withheld when a preview was shortened", async () => {
    const user = userEvent.setup();
    renderStep(
      toolPart({ argsPreview: { json: '{"channel":"#ops"}', truncated: true, bytes: 12_400 } })
    );

    await user.click(step());
    expect(screen.getByText("Shortened for display · 12.1 kB total")).toBeInTheDocument();
  });

  it("never renders the digest envelope as an Input pane", async () => {
    const user = userEvent.setup();
    renderStep(toolPart({ resultPreview: { json: "{}" } }));

    await user.click(step());

    // The digest is a receipt, not an argument: it belongs in the metadata strip.
    expect(screen.queryByText("Input")).toBeNull();
    expect(screen.getByText("sha256:4b7e")).toBeInTheDocument();
  });

  it("marks a failed call with its error code, without waiting to be opened", () => {
    renderStep(toolPart({ outcome: "error", meta: { errorCode: "channel_not_found" } }));

    expect(step()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("channel_not_found")).toBeInTheDocument();
  });

  it("flags a tool that can write on the face of the step", () => {
    renderStep(toolPart({ meta: { mutating: true } }));
    expect(screen.getByLabelText("This tool can write")).toBeInTheDocument();
  });

  it("offers no expansion affordance when there is nothing to inspect", () => {
    const { container } = renderStep(toolPart());

    // A chevron onto an empty panel is worse than no chevron: the step is a plain row.
    expect(screen.queryByRole("button", { name: /github_issue_comment/i })).toBeNull();
    expect(container.querySelector(".tf-trace-row")).not.toBeNull();
  });

  it("stays expandable when a preview is too large to parse", async () => {
    // An over-cap preview used to make the row non-expandable, which hid the truncation notice
    // along with the value — the reader saw a dead row and no explanation.
    renderStep(toolPart({ argsPreview: { json: '{"repo":"maddhruv/tul', truncated: true } }));

    await userEvent.click(step());
    expect(screen.getByText("Input")).toBeInTheDocument();
  });

  it("renders the running state while the call is still in flight", () => {
    const { container } = renderStep(toolPart({ status: "running", outcome: undefined }), {
      pending: true,
    });

    expect(container.querySelector(".tf-trace-row .lucide-loader-circle")).not.toBeNull();
    expect(container.querySelector(".text-run-active")).not.toBeNull();
  });
});
