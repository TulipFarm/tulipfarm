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

  expect(screen.getByText("[approval required]")).toBeInTheDocument();
  expect(screen.getByText("write_thing")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "deny" }));
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

  expect(screen.getByText("denied")).toBeInTheDocument();
  expect(screen.queryByRole("button")).toBeNull();
});
