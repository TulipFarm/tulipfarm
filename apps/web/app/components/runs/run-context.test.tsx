import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { OperationalRun } from "~/lib/operations";
import { RunContext } from "./run-context";

function renderContext(context?: OperationalRun["context"]) {
  const Stub = createRemixStub([{ path: "/", Component: () => <RunContext context={context} /> }]);
  return render(<Stub />);
}

describe("Run related work", () => {
  it("links only typed authorized context using canonical routes", () => {
    renderContext({
      sourceChat: { id: "chat-1", title: "Review support tickets" },
      agent: { id: "agent-immutable-id", name: "support-agent" },
      routine: { id: "routine-immutable-id", name: "daily-review" },
      relatedRuns: [
        { id: "run-parent", relation: "parent" },
        { id: "run-child", relation: "child" },
        { id: "run-original", relation: "replayed_from" },
        { id: "run-replay", relation: "replay" },
      ],
    });
    expect(screen.getByRole("link", { name: "Review support tickets" })).toHaveAttribute(
      "href",
      "/chat/chat-1"
    );
    expect(screen.getByRole("link", { name: "support-agent" })).toHaveAttribute(
      "href",
      "/agents/support-agent"
    );
    expect(screen.getByRole("link", { name: "daily-review" })).toHaveAttribute(
      "href",
      "/routines/daily-review"
    );
    expect(screen.getByText("Parent Run")).toBeInTheDocument();
    expect(screen.getByText("Child Run")).toBeInTheDocument();
    expect(screen.getByText("Replayed from")).toBeInTheDocument();
    expect(screen.getByText("Replay Run")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "run-original" })).toHaveAttribute(
      "href",
      "/runs/run-original"
    );
  });

  it.each([undefined, { relatedRuns: [] }])(
    "omits missing context without inferring absence",
    (context) => {
      renderContext(context);
      expect(screen.queryByRole("heading", { name: "Related work" })).not.toBeInTheDocument();
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
    }
  );

  it("encodes route keys and wraps long titles without clipping", () => {
    const title = "LongRecordedTitle".repeat(100);
    renderContext({ sourceChat: { id: "chat/one", title }, relatedRuns: [] });
    const link = screen.getByRole("link", { name: title });
    expect(link).toHaveAttribute("href", "/chat/chat%2Fone");
    expect(link).toHaveClass("[overflow-wrap:anywhere]");
    expect(link).not.toHaveClass("truncate");
  });
});
