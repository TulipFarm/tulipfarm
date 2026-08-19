import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PageForm } from "./page-form";

vi.mock("@tulipfarm/editor", () => ({
  PageEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="body" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

vi.mock("~/components/knowledge/use-wiki-mention-data", () => ({
  useWikiMentionExtensions: () => [],
}));

function mount(props: Partial<React.ComponentProps<typeof PageForm>> = {}) {
  const onSubmit = props.onSubmit ?? vi.fn();
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => (
        <PageForm
          mode="create"
          spaceId="s1"
          onSubmit={onSubmit}
          submitting={false}
          cancelTo="/knowledge"
          {...props}
        />
      ),
    },
    { path: "/knowledge", Component: () => <p>elsewhere</p> },
  ]);
  render(<Stub initialEntries={["/"]} />);
  return { onSubmit };
}

describe("PageForm", () => {
  it("reports a rejected path against the path field, not only at the top", async () => {
    mount({ fieldErrors: { path: "path is already taken" } });

    const field = screen.getByLabelText(/path/i);
    expect(screen.getByText("path is already taken")).toBeInTheDocument();
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(/already taken/i);
  });

  it("keeps what the author wrote when the save fails", async () => {
    const user = userEvent.setup();
    mount({ formError: "network unreachable" });

    await user.type(screen.getByLabelText("body"), "half a post-mortem");
    expect(screen.getByText(/network unreachable/i)).toBeInTheDocument();
    expect(screen.getByLabelText("body")).toHaveValue("half a post-mortem");
  });

  it("does not warn about leaving a form nobody has touched", () => {
    mount();
    expect(dispatchUnload()).toBe(false);
  });

  it("warns before an accidental navigation discards unsaved work", async () => {
    const user = userEvent.setup();
    mount();

    await user.type(screen.getByLabelText("body"), "unsaved");
    expect(dispatchUnload()).toBe(true);
  });

  it("stops warning once the work has been handed to the server", async () => {
    const user = userEvent.setup();
    mount({ onSubmit: vi.fn() });

    await user.type(screen.getByLabelText(/path/i), "notes/one");
    await user.type(screen.getByLabelText("body"), "saved");
    await user.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => expect(dispatchUnload()).toBe(false));
  });

  it("offers a way back before an in-SPA navigation discards unsaved work", async () => {
    const user = userEvent.setup();
    mount();

    await user.type(screen.getByLabelText("body"), "unsaved");
    await user.click(screen.getByRole("link", { name: /cancel/i }));

    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(screen.queryByText("elsewhere")).toBeNull();

    await user.click(screen.getByRole("button", { name: /keep editing/i }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByLabelText("body")).toHaveValue("unsaved");
  });

  it("lets the author leave once they have said to discard", async () => {
    const user = userEvent.setup();
    mount();

    await user.type(screen.getByLabelText("body"), "unsaved");
    await user.click(screen.getByRole("link", { name: /cancel/i }));
    await user.click(await screen.findByRole("button", { name: /discard changes/i }));

    expect(await screen.findByText("elsewhere")).toBeInTheDocument();
  });

  it("submits the path and the composed content", async () => {
    const user = userEvent.setup();
    const { onSubmit } = mount();

    await user.type(screen.getByLabelText(/path/i), "  notes/one  ");
    await user.type(screen.getByLabelText("body"), "hello");
    await user.click(screen.getByRole("button", { name: /create/i }));

    expect(onSubmit).toHaveBeenCalledWith("notes/one", expect.stringContaining("hello"));
  });
});

/** @returns whether something asked the browser to confirm leaving the page. */
function dispatchUnload(): boolean {
  const e = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
}
