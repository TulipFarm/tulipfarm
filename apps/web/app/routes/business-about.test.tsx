import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { getPublicOrigins, getUpdateCheck, savePublicOrigins } from "~/lib/system";
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
    canWrite: true,
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

test("host-owned origins stay locked for an administrator and keep API origin distinct", async () => {
  vi.mocked(getPublicOrigins).mockResolvedValue({
    webOrigin: "https://web.operator.test",
    apiOrigin: "https://api.operator.test",
    callbackUrl: "https://api.operator.test/api/v1/integrations/auth/callback",
    source: "environment",
    locked: true,
    lockReason: "hosting_operator",
    canWrite: false,
  });
  render(<BusinessAbout />);
  expect(await screen.findByText(/Managed by the hosting operator/)).toBeInTheDocument();
  expect(screen.getByDisplayValue("https://web.operator.test")).toBeDisabled();
  expect(screen.getByDisplayValue("https://api.operator.test")).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Use this browser address" })
  ).not.toBeInTheDocument();
});

test("ownership metadata failures are visible and fail closed", async () => {
  vi.mocked(getPublicOrigins).mockRejectedValue(
    new Error("Settings unavailable. Retry this page.")
  );
  render(<BusinessAbout />);
  expect(await screen.findByText("Settings unavailable. Retry this page.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
});

test("server rejection remains visible after an editable projection", async () => {
  vi.mocked(getPublicOrigins).mockResolvedValue({
    webOrigin: "https://web.operator.test",
    apiOrigin: "https://api.operator.test",
    callbackUrl: "https://api.operator.test/api/v1/integrations/auth/callback",
    source: "environment",
    locked: false,
    canWrite: true,
  });
  vi.mocked(savePublicOrigins).mockRejectedValue(new Error("Managed by the hosting operator."));
  render(<BusinessAbout />);
  await userEvent.click(await screen.findByRole("button", { name: "Save" }));
  expect(await screen.findByText("Managed by the hosting operator.")).toBeInTheDocument();
});
