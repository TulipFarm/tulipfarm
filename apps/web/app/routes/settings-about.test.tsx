import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { getUpdateCheck } from "~/lib/system";
import SettingsAbout from "./_app.settings.about";

vi.mock("~/lib/system", () => ({ getUpdateCheck: vi.fn() }));

test("shows the current version and supports an explicit update check", async () => {
  vi.mocked(getUpdateCheck).mockResolvedValue({
    version: "0.4.4",
    latest: "0.4.4",
    updateAvailable: false,
  });
  const user = userEvent.setup();
  render(<SettingsAbout />);

  expect(await screen.findByText("Version 0.4.4")).toBeInTheDocument();
  expect(screen.getByText("You are up to date.")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Check for updates" }));
  expect(getUpdateCheck).toHaveBeenCalledTimes(2);
});
