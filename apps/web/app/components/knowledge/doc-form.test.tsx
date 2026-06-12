import { createRemixStub } from "@remix-run/testing";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DocForm, type DocFormProps } from "./doc-form";

function renderForm(overrides: Partial<DocFormProps> = {}): DocFormProps {
  const props: DocFormProps = {
    mode: "create",
    onSubmit: vi.fn(),
    submitting: false,
    cancelTo: "/knowledge/documents",
    ...overrides,
  };
  const Stub = createRemixStub([{ path: "/", Component: () => <DocForm {...props} /> }]);
  render(<Stub initialEntries={["/"]} />);
  return props;
}

describe("DocForm", () => {
  it("renders title, content, tags, domain, and the governance toggle", () => {
    renderForm();
    expect(screen.getByLabelText(/title/)).toBeInTheDocument();
    expect(screen.getByLabelText(/content/)).toBeInTheDocument();
    expect(screen.getByLabelText(/tags/)).toBeInTheDocument();
    expect(screen.getByLabelText(/domain/)).toBeInTheDocument();
    expect(screen.getByLabelText(/alwaysLoadForAgents/)).toBeInTheDocument();
  });

  it("preview toggle renders markdown instead of the textarea", () => {
    renderForm({ initial: { content: "# Heading" } });
    fireEvent.click(screen.getByText("preview"));
    expect(screen.getByRole("heading", { name: "Heading" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/content/)).not.toBeInTheDocument();
  });

  it("splits comma-separated tags and nulls an empty domain on submit", () => {
    const props = renderForm({ initial: { title: "T", content: "C" } });
    fireEvent.change(screen.getByLabelText(/tags/), { target: { value: "a, b ,, c " } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(props.onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "T",
        content: "C",
        tags: ["a", "b", "c"],
        domain: null,
        alwaysLoadForAgents: false,
      })
    );
  });

  it("shows a form-level error banner", () => {
    renderForm({ formError: "this document changed since you loaded it — reload and retry" });
    expect(screen.getByText(/this document changed/)).toBeInTheDocument();
  });
});
