import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { ApprovalCard } from "~/components/chat/approval-card";

test("pending approval shows approve/deny and fires the decision", async () => {
  const user = userEvent.setup();
  const onDecide = vi.fn();
  render(
    <ApprovalCard
      toolName="write_thing"
      approval={{
        approvalId: "ap1",
        status: "pending",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }}
      onDecide={onDecide}
    />
  );

  expect(screen.getByText("Needs your approval")).toBeInTheDocument();
  expect(screen.getByText("write_thing")).toBeInTheDocument();

  // The bare number is meaningless without saying what runs out; the sentence carries the stakes.
  expect(screen.getByText(/^Expires in \d+ seconds$/)).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Deny" }));
  expect(onDecide).toHaveBeenCalledWith("deny");
});

test("resolved approval shows the outcome and no buttons", () => {
  render(
    <ApprovalCard
      toolName="write_thing"
      approval={{ approvalId: "ap1", status: "denied" }}
      onDecide={vi.fn()}
    />
  );

  expect(screen.getByText("Denied")).toBeInTheDocument();
  expect(screen.queryByRole("button")).toBeNull();
});

test("prevents duplicate decisions and exposes a retriable request failure", async () => {
  const user = userEvent.setup();
  let rejectDecision: ((error: Error) => void) | undefined;
  const onDecide = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectDecision = reject;
      })
  );
  render(
    <ApprovalCard
      toolName="write_thing"
      approval={{ approvalId: "ap1", status: "pending" }}
      onDecide={onDecide}
    />
  );

  const approve = screen.getByRole("button", { name: "Approve" });
  await user.click(approve);
  await user.click(approve);
  expect(onDecide).toHaveBeenCalledOnce();
  expect(approve).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("Submitting approval");

  rejectDecision?.(new Error("network unavailable"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Approval could not be submitted. Try again."
  );
  expect(approve).toBeEnabled();

  await user.click(approve);
  expect(onDecide).toHaveBeenCalledTimes(2);
});
