import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { InboxItem } from "./inbox-item";

const item = {
  id: "approval-1",
  kind: "approval" as const,
  title: "Create GitHub issue",
  status: "pending",
  risk: "high" as const,
  intentDigest: "sha256:intent",
  guardrailRevision: "gr-7",
  target: "acme/repo",
  destination: "github.com/acme/repo",
  fields: ["title", "body"],
  expiresAt: "2026-07-26T12:00:00Z",
  decisions: 1,
  requiredDecisions: 2,
  canDecide: true,
};

describe("InboxItem", () => {
  it("shows exact intent, destination, risk, expiry, fields, and four-eyes state", () => {
    render(<InboxItem item={item} onDecision={vi.fn()} />);
    expect(screen.getByText("sha256:intent")).toBeInTheDocument();
    expect(screen.getByText("github.com/acme/repo")).toBeInTheDocument();
    expect(screen.getByText("title, body")).toBeInTheDocument();
    expect(screen.getByText("1 / 2 decisions")).toBeInTheDocument();
  });

  it("cannot self-approve when the server read model denies it", async () => {
    const user = userEvent.setup();
    const onDecision = vi.fn();
    render(
      <InboxItem
        item={{ ...item, canDecide: false, denialReason: "Proposer cannot approve" }}
        onDecision={onDecision}
      />
    );
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(onDecision).not.toHaveBeenCalled();
  });
});
