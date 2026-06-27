import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SpaceForm } from "./space-form";

function renderForm(onSubmit: (body: { name: string; description?: string | null }) => void) {
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => (
        <SpaceForm mode="create" onSubmit={onSubmit} submitting={false} cancelTo="/knowledge" />
      ),
    },
  ]);
  return render(<Stub />);
}

describe("SpaceForm", () => {
  it("blocks an empty-name submit and shows a validation message", async () => {
    const onSubmit = vi.fn();
    renderForm(onSubmit);

    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("name is required")).toBeInTheDocument();
  });

  it("submits the trimmed name (and clears the error once typing resumes)", async () => {
    const onSubmit = vi.fn();
    renderForm(onSubmit);

    // Trip the validation, then start typing — the message should clear.
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await userEvent.type(screen.getByLabelText(/name/i), "  Manual QA  ");
    expect(screen.queryByText("name is required")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onSubmit).toHaveBeenCalledWith({ name: "Manual QA", description: null });
  });
});
