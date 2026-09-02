import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelinePart } from "~/lib/chat/types";
import * as useSessionUser from "~/lib/use-session-user";
import { ToolTrace } from "./tool-trace";

vi.mock("~/lib/use-session-user", async () => {
  const actual =
    await vi.importActual<typeof import("~/lib/use-session-user")>("~/lib/use-session-user");
  return { ...actual, useIsAdmin: vi.fn(() => true) };
});
const useIsAdmin = vi.mocked(useSessionUser.useIsAdmin);

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

/**
 * One call still draws as a run of one, so this is the step's contract, not the run's.
 *
 * Routed through a stub router (rather than a bare `render`) because a step can render a `<Link>`
 * to the secrets page, which requires router context.
 */
function renderStep(part: ToolPart, options?: { pending?: boolean }) {
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => (
        <ToolTrace
          parts={[part]}
          pending={options?.pending === true}
          foldable={false}
          onApprove={vi.fn()}
        />
      ),
    },
  ]);
  return render(<Stub />);
}

const step = () => screen.getByRole("button", { name: /github_issue_comment/i });

describe("A Tool step on the trace", () => {
  beforeEach(() => {
    useIsAdmin.mockReturnValue(true);
  });

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

  it("offers a member the required Credential link when they are an admin", () => {
    useIsAdmin.mockReturnValue(true);
    renderStep(
      toolPart({
        outcome: "error",
        meta: { errorCode: "missing_credential", connectUrl: "/business/secrets?required=FOO" },
      })
    );

    expect(screen.getByRole("link", { name: "Add the required Credential →" })).toHaveAttribute(
      "href",
      "/business/secrets?required=FOO"
    );
  });

  it("tells a non-admin to ask an administrator instead of linking to the admin-only page", () => {
    useIsAdmin.mockReturnValue(false);
    renderStep(
      toolPart({
        outcome: "error",
        meta: { errorCode: "missing_credential", connectUrl: "/business/secrets?required=FOO" },
      })
    );

    expect(screen.queryByRole("link", { name: /Add the required Credential/i })).toBeNull();
    expect(screen.getByText("Ask an administrator to add this Credential.")).toBeInTheDocument();
  });

  it("renders the running state while the call is still in flight", () => {
    const { container } = renderStep(toolPart({ status: "running", outcome: undefined }), {
      pending: true,
    });

    expect(container.querySelector(".tf-trace-row .lucide-loader-circle")).not.toBeNull();
    expect(container.querySelector(".text-run-active")).not.toBeNull();
  });
});
