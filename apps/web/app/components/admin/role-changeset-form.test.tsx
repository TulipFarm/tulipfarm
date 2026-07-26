import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RoleChangesetForm } from "./role-changeset-form";

describe("RoleChangesetForm", () => {
  it("proposes a custom Role through the governed changeset boundary", async () => {
    const user = userEvent.setup();
    const onPropose = vi.fn().mockResolvedValue(undefined);
    render(<RoleChangesetForm onPropose={onPropose} />);

    await user.type(screen.getByLabelText("Role ID"), "incident-commander");
    await user.type(screen.getByLabelText("Role name"), "Incident commander");
    await user.type(screen.getByLabelText("Principal kinds"), "user, agent");
    await user.type(screen.getByLabelText("Grants"), "runs:read, runs:reconcile");
    await user.click(screen.getByRole("button", { name: "Propose Role" }));

    expect(onPropose).toHaveBeenCalledWith({
      id: "incident-commander",
      name: "Incident commander",
      principalKinds: ["user", "agent"],
      grants: ["runs:read", "runs:reconcile"],
      conditions: [],
    });
    expect(screen.getByText("Role changeset proposed.")).toBeInTheDocument();
  });
});
