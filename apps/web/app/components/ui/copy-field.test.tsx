import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { CopyField } from "./copy-field";

vi.mock("~/lib/clipboard", () => ({ copyText: vi.fn() }));

import { copyText } from "~/lib/clipboard";

beforeEach(() => {
  vi.mocked(copyText).mockReset();
});

test("copies the value it displays", async () => {
  const user = userEvent.setup();
  vi.mocked(copyText).mockResolvedValue(true);
  render(<CopyField value="https://example.com/hook" />);

  await user.click(screen.getByRole("button", { name: /copy/i }));
  expect(copyText).toHaveBeenCalledWith("https://example.com/hook");
  expect(await screen.findByText("Copied")).toBeInTheDocument();
});

test("stays silent when the copy did not land", async () => {
  // `copyText` falls back to execCommand on insecure origins and can fail outright. Claiming
  // success anyway is how someone ends up pasting stale clipboard contents into a provider.
  const user = userEvent.setup();
  vi.mocked(copyText).mockResolvedValue(false);
  render(<CopyField value="https://example.com/hook" />);

  await user.click(screen.getByRole("button", { name: /copy/i }));
  expect(screen.queryByText("Copied")).not.toBeInTheDocument();
});

test("names the button when several copyable values share a screen", () => {
  render(<CopyField value="https://example.com/hook" label="webhook URL" />);
  expect(screen.getByRole("button", { name: "Copy webhook URL" })).toBeInTheDocument();
});
