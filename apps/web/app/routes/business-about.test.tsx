import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { getPublicOrigins, getUpdateCheck } from "~/lib/system";
import BusinessAbout from "./_app.business.about";

vi.mock("~/lib/system", () => ({
  getUpdateCheck: vi.fn(),
  getPublicOrigins: vi.fn(),
  savePublicOrigins: vi.fn(),
  resetPublicOrigins: vi.fn(),
}));
vi.mock("~/lib/use-session-user", () => ({ useIsAdmin: () => true }));

test("shows the current version and supports an explicit update check", async () => {
  vi.mocked(getUpdateCheck).mockResolvedValue({
    version: "0.4.4",
    latest: "0.4.4",
    updateAvailable: false,
  });
  vi.mocked(getPublicOrigins).mockResolvedValue({
    webOrigin: "https://tulip.example.com",
    apiOrigin: "https://tulip.example.com",
    callbackUrl: "https://tulip.example.com/api/v1/integrations/auth/callback",
    source: "database",
    locked: false,
  });
  const user = userEvent.setup();
  render(<BusinessAbout />);

  expect(await screen.findByText("Version 0.4.4")).toBeInTheDocument();
  expect(screen.getByText("You are up to date.")).toBeInTheDocument();
  expect(await screen.findByDisplayValue("https://tulip.example.com")).toBeInTheDocument();
  expect(screen.getByText(/api\/v1\/integrations\/auth\/callback/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Check for updates" }));
  expect(getUpdateCheck).toHaveBeenCalledTimes(2);
});
