import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";
import { decideApproval, getInbox } from "~/lib/inbox";
import Inbox, { clientLoader } from "./_app.inbox";

vi.mock("~/lib/inbox", () => ({
  getInbox: vi.fn(),
  decideApproval: vi.fn(),
}));

const item = {
  id: "approval-1",
  kind: "approval" as const,
  title: "Hand the File over to Engineering",
  status: "pending",
  risk: "high" as const,
  target: "file:1",
  expiresAt: "2026-07-26T12:00:00Z",
  createdAt: "2026-07-25T12:00:00Z",
  decisions: 0,
  requiredDecisions: 1,
  canDecide: true,
};

function renderPage() {
  const Stub = createRemixStub([{ path: "/inbox", Component: Inbox, loader: clientLoader }]);
  return render(<Stub initialEntries={["/inbox"]} />);
}

beforeEach(() => {
  vi.mocked(getInbox).mockResolvedValue([item]);
});

test("shows why the server refused a decision instead of swallowing it", async () => {
  vi.mocked(decideApproval).mockRejectedValue(
    new ApiError(403, "You cannot approve a change you proposed.")
  );

  renderPage();
  await userEvent.click(await screen.findByRole("button", { name: "Approve" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "You cannot approve a change you proposed."
  );
});

test("clears a previous refusal once a decision is accepted", async () => {
  vi.mocked(decideApproval)
    .mockRejectedValueOnce(new ApiError(403, "You cannot approve a change you proposed."))
    .mockResolvedValueOnce({
      approvalId: "approval-1",
      status: "approved",
      decisions: 1,
      requiredDecisions: 1,
    });

  renderPage();
  const deny = await screen.findByRole("button", { name: "Deny" });
  await userEvent.click(deny);
  expect(await screen.findByRole("alert")).toBeInTheDocument();

  await userEvent.click(deny);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
