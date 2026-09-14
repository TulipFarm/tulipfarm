import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import {
  addOimTrustRoot,
  disableOimTrustRoot,
  getOimRevocationFeed,
  listOimTrustRoots,
  runOimReleaseMaintenance,
  setOimRevocationFeed,
} from "~/lib/integrations";
import { OimReleaseSecurityDialog } from "./oim-release-security-dialog";

vi.mock("~/lib/integrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/integrations")>()),
  addOimTrustRoot: vi.fn(),
  disableOimRevocationFeed: vi.fn(),
  disableOimTrustRoot: vi.fn(),
  getOimRevocationFeed: vi.fn(),
  listOimTrustRoots: vi.fn(),
  runOimReleaseMaintenance: vi.fn(),
  setOimRevocationFeed: vi.fn(),
}));

const root = {
  purpose: "release" as const,
  keyId: "release-2026",
  publicKeyPem: "-----BEGIN PUBLIC KEY-----\npublic\n-----END PUBLIC KEY-----",
  createdAt: "2026-09-13T09:00:00.000Z",
  createdBy: "operator-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listOimTrustRoots).mockResolvedValue([root]);
  vi.mocked(getOimRevocationFeed).mockResolvedValue(null);
});

test("manages public trust without asking TulipFarm for signing private keys", async () => {
  vi.mocked(addOimTrustRoot).mockResolvedValue(root);
  vi.mocked(disableOimTrustRoot).mockResolvedValue({
    ...root,
    disabledAt: "2026-09-13T10:00:00.000Z",
    disabledBy: "operator-1",
  });
  const user = userEvent.setup();
  render(<OimReleaseSecurityDialog open onClose={vi.fn()} />);

  expect(await screen.findByText(/signing private keys with the package publisher/i)).toBeVisible();
  expect(screen.getByText("release-2026")).toBeVisible();

  await user.type(screen.getByLabelText("Key ID"), "release-2027");
  await user.type(
    screen.getByLabelText("PEM public key"),
    "-----BEGIN PUBLIC KEY-----\nnext\n-----END PUBLIC KEY-----"
  );
  await user.click(screen.getByRole("button", { name: "Add public trust root" }));

  expect(addOimTrustRoot).toHaveBeenCalledWith({
    purpose: "release",
    keyId: "release-2027",
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\nnext\n-----END PUBLIC KEY-----",
  });

  await user.click(screen.getByRole("button", { name: "Disable" }));
  expect(screen.getByRole("heading", { name: "Confirm disable" })).toHaveFocus();
  expect(
    screen.getByRole("heading", { name: "Confirm disable" }).closest("section")
  ).toHaveTextContent("New packages using this public key will not verify.");
  await user.click(screen.getByRole("button", { name: "Confirm disable" }));
  expect(disableOimTrustRoot).toHaveBeenCalledWith("release", "release-2026");
});

test("saves the signed feed and reports explicit maintenance results", async () => {
  vi.mocked(setOimRevocationFeed).mockResolvedValue({
    url: "https://updates.example.test/oim.json",
    updatedAt: "2026-09-13T09:00:00.000Z",
    updatedBy: "operator-1",
  });
  vi.mocked(runOimReleaseMaintenance).mockResolvedValue({
    feed: "updated",
    patches: [
      { integrationId: "weather", majorVersion: 1, status: "updated", version: "1.2.4" },
      { integrationId: "calendar", majorVersion: 2, status: "failed", reason: "network" },
    ],
  });
  const user = userEvent.setup();
  render(<OimReleaseSecurityDialog open onClose={vi.fn()} />);

  await user.type(
    await screen.findByLabelText("Signed revocation feed URL"),
    "https://updates.example.test/oim.json"
  );
  await user.click(screen.getByRole("button", { name: "Save feed" }));
  expect(setOimRevocationFeed).toHaveBeenCalledWith("https://updates.example.test/oim.json");

  await user.click(screen.getByRole("button", { name: "Run maintenance" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Revocations updated; 1 package updates applied; 1 failed."
    )
  );
});
