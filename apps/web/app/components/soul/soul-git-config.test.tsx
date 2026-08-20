import { render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type { SoulGitConfig, SoulGitStatus } from "~/lib/soul";
import * as useSessionUser from "~/lib/use-session-user";
import { SoulGitConfigPanel } from "./soul-git-config";

vi.mock("~/lib/use-session-user", async () => {
  const actual =
    await vi.importActual<typeof import("~/lib/use-session-user")>("~/lib/use-session-user");
  return { ...actual, useIsAdmin: vi.fn(() => true) };
});
const useIsAdmin = vi.mocked(useSessionUser.useIsAdmin);

function status(overrides: Partial<SoulGitStatus> = {}): SoulGitStatus {
  return {
    remoteConfigured: true,
    ahead: 0,
    behind: 0,
    headSha: "0123456789abcdef0123456789abcdef01234567",
    lastSyncError: null,
    lastSyncAt: "2026-08-19T01:02:00.000Z",
    ...overrides,
  };
}

function renderPanel(config: SoulGitConfig) {
  return render(<SoulGitConfigPanel config={config} onSaved={() => {}} />);
}

beforeEach(() => {
  useIsAdmin.mockReturnValue(true);
});

test("shows Not connected while an admin sees the connect form", () => {
  renderPanel({
    credentialSet: false,
    status: status({ remoteConfigured: false, headSha: null, lastSyncAt: null }),
  });

  expect(screen.getByText("Connect a git remote")).toBeTruthy();
  expect(screen.getByText("Not connected")).toBeTruthy();
});

test("shows Not connected to a non-admin who cannot open the form", () => {
  useIsAdmin.mockReturnValue(false);
  renderPanel({
    credentialSet: false,
    status: status({ remoteConfigured: false, headSha: null, lastSyncAt: null }),
  });

  expect(screen.getByText("Not connected")).toBeTruthy();
});

test("shows Up to date with the last sync time and head commit", () => {
  renderPanel({
    remoteUrl: "https://github.com/northgate/soul.git",
    credentialSet: true,
    status: status(),
  });

  expect(screen.getByText("Up to date")).toBeTruthy();
  expect(screen.getByText(/last synced/)).toBeTruthy();
  expect(screen.getByText("0123456")).toBeTruthy();
});

test("shows the ahead/behind counts when the remote has diverged", () => {
  renderPanel({
    remoteUrl: "https://github.com/northgate/soul.git",
    credentialSet: true,
    status: status({ ahead: 2, behind: 3 }),
  });

  expect(screen.getByText("2 ahead, 3 behind")).toBeTruthy();
});

test("shows Sync failed with the failure reason", () => {
  renderPanel({
    remoteUrl: "https://github.com/northgate/soul.git",
    credentialSet: true,
    status: status({ lastSyncError: "could not read Username for 'https://github.com'" }),
  });

  expect(screen.getByText("Sync failed")).toBeTruthy();
  expect(screen.getByText(/personal access token/)).toBeTruthy();
});

test("says never synced when a configured remote has never been reached", () => {
  renderPanel({
    remoteUrl: "https://github.com/northgate/soul.git",
    credentialSet: true,
    status: status({ lastSyncAt: null, headSha: null }),
  });

  expect(screen.getByText("never synced")).toBeTruthy();
});

test("keeps the status visible while an admin edits a configured remote", async () => {
  const user = (await import("@testing-library/user-event")).default;
  renderPanel({
    remoteUrl: "https://github.com/northgate/soul.git",
    credentialSet: true,
    status: status({ ahead: 1, behind: 0 }),
  });

  await user.click(screen.getByRole("button", { name: "Edit" }));

  expect(screen.getByText("Edit git remote")).toBeTruthy();
  expect(screen.getByText("1 ahead")).toBeTruthy();
});
