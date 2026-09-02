import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { Composer } from "./composer";

// Stand in for Tiptap, held closed until the test opens it. Loading the real editor would prove the
// swap happened but not which text crossed it, and letting the mock resolve at once would skip the
// stand-in entirely — the two things these tests exist to pin down.
const editor = vi.hoisted(() => {
  let release: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release, drafts: [] as (string | undefined)[] };
});

vi.mock("./composer-editor", async () => {
  await editor.ready;
  return {
    ComposerEditor: ({ initialDraft }: { initialDraft?: string }) => {
      editor.drafts.push(initialDraft);
      return <div data-testid="composer-editor">{initialDraft}</div>;
    },
  };
});

test("the stand-in shows a seeded draft rather than an empty box", () => {
  render(<Composer initialDraft="from the link" onSend={vi.fn()} />);

  expect(screen.getByLabelText("Message")).toHaveValue("from the link");
});

test("sends from the stand-in without waiting for the editor", async () => {
  const user = userEvent.setup();
  const onSend = vi.fn();
  render(<Composer onSend={onSend} />);

  await user.type(screen.getByLabelText("Message"), "send me");
  await user.click(screen.getByRole("button", { name: "Send prompt" }));

  expect(onSend).toHaveBeenCalledWith("send me", expect.objectContaining({ skills: [] }));
});

test("hands anything typed into the stand-in over to the editor it is replaced by", async () => {
  const user = userEvent.setup();
  render(<Composer initialDraft="seeded" onSend={vi.fn()} />);

  const fallback = screen.getByLabelText("Message");
  await user.clear(fallback);
  await user.type(fallback, "typed while loading");

  editor.release();

  await waitFor(() => {
    expect(screen.getByTestId("composer-editor")).toBeInTheDocument();
  });
  expect(editor.drafts.at(-1)).toBe("typed while loading");
});
