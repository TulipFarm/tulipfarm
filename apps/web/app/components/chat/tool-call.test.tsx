import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TimelinePart } from "~/lib/chat/types";
import { ToolCallRow } from "./tool-call";

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

describe("ToolCallRow", () => {
  it("summarises the call in words instead of printing the tool name alone", () => {
    render(
      <ToolCallRow
        part={toolPart({
          argsPreview: { json: JSON.stringify({ repo: "maddhruv/tulipfarm", issue: 412 }) },
        })}
        onApprove={vi.fn()}
      />
    );

    expect(screen.getByText("Commented on maddhruv/tulipfarm#412")).toBeInTheDocument();
    expect(screen.getByText("github_issue_comment")).toBeInTheDocument();
  });

  it("reports a finished call as succeeded even when only a preview came back", () => {
    const { container } = render(
      <ToolCallRow
        part={toolPart({ resultPreview: { json: '{"ok":true}' } })}
        onApprove={vi.fn()}
      />
    );

    // A completed call is reported by `status`, not by whether a verbatim result was streamed —
    // on a live stream the verbatim result never arrives.
    expect(container.querySelector(".lucide-check")).not.toBeNull();
  });

  it("separates Input from Output and names every withheld field", async () => {
    const user = userEvent.setup();
    render(
      <ToolCallRow
        part={toolPart({
          argsPreview: {
            json: JSON.stringify({ repo: "maddhruv/tulipfarm", token: "[redacted]" }),
            redactedPaths: ["token"],
          },
          resultPreview: { json: JSON.stringify({ success: true }) },
        })}
        onApprove={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: /github_issue_comment/i }));

    expect(screen.getByText("Input")).toBeInTheDocument();
    expect(screen.getByText("Output")).toBeInTheDocument();
    expect(screen.getByText("redacted")).toBeInTheDocument();
    expect(screen.getByText("1 field withheld")).toBeInTheDocument();
  });

  it("says how much was withheld when a preview was shortened", async () => {
    const user = userEvent.setup();
    render(
      <ToolCallRow
        part={toolPart({
          argsPreview: { json: '{"channel":"#ops"}', truncated: true, bytes: 12_400 },
        })}
        onApprove={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: /github_issue_comment/i }));
    expect(screen.getByText("Shortened for display · 12.1 kB total")).toBeInTheDocument();
  });

  it("never renders the digest envelope as an Input pane", async () => {
    const user = userEvent.setup();
    render(<ToolCallRow part={toolPart({ resultPreview: { json: "{}" } })} onApprove={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /github_issue_comment/i }));

    // The digest is a receipt, not an argument: it belongs in the metadata strip.
    expect(screen.queryByText("Input")).toBeNull();
    expect(screen.getByText("sha256:4b7e")).toBeInTheDocument();
  });

  it("marks a failed call with its error code", () => {
    render(
      <ToolCallRow
        part={toolPart({ outcome: "error", meta: { errorCode: "channel_not_found" } })}
        onApprove={vi.fn()}
      />
    );

    expect(screen.getByText("channel_not_found")).toBeInTheDocument();
  });

  it("flags a tool that can write", () => {
    render(<ToolCallRow part={toolPart({ meta: { mutating: true } })} onApprove={vi.fn()} />);
    expect(screen.getByLabelText("This tool can write")).toBeInTheDocument();
  });

  it("shows no expansion affordance when there is nothing to inspect", () => {
    render(<ToolCallRow part={toolPart()} onApprove={vi.fn()} />);
    expect(screen.getByRole("button", { name: /github_issue_comment/i })).toBeDisabled();
  });

  it("stays expandable when a preview is too large to parse", async () => {
    // An over-cap preview used to make the row non-expandable, which hid the truncation notice
    // along with the value — the reader saw a dead row and no explanation.
    render(
      <ToolCallRow
        part={toolPart({ argsPreview: { json: '{"repo":"maddhruv/tul', truncated: true } })}
        onApprove={vi.fn()}
      />
    );

    const row = screen.getByRole("button", { name: /github_issue_comment/i });
    expect(row).toBeEnabled();
    await userEvent.click(row);
    expect(screen.getByText("Input")).toBeInTheDocument();
  });

  it("renders the running state while the call is still in flight", () => {
    const { container } = render(
      <ToolCallRow
        part={toolPart({ status: "running", outcome: undefined })}
        streaming
        onApprove={vi.fn()}
      />
    );

    expect(container.querySelector(".run-rail-active")).not.toBeNull();
    expect(container.querySelector(".text-run-active")).not.toBeNull();
  });
});
