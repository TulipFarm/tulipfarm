import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import * as setupLib from "~/lib/setup";
import * as soulLib from "~/lib/soul";
import SetupRoute from "./setup";

/*
 * Setup wizard flow tests, focused on the conditional Soul backup step: the step is hidden
 * (3-step wizard, finish after LLM) when the soul git remote is already configured — e.g. seeded
 * by SOUL_GIT_REMOTE_URL/SOUL_GIT_CREDENTIAL env vars at boot — and shown otherwise. Remote state
 * comes from getGitConfig() (fetched once, right after the admin step logs the user in).
 */

vi.mock("~/lib/setup", () => ({
  getSetupStatus: vi.fn(),
  setupAdmin: vi.fn(),
  setupBusiness: vi.fn(),
  setupGit: vi.fn(),
  completeSetup: vi.fn(),
}));
vi.mock("~/lib/soul", () => ({
  getGitConfig: vi.fn(),
  friendlyGitError: (raw: string) => raw,
}));
vi.mock("~/lib/settings", () => ({
  listProviders: vi.fn().mockResolvedValue([]),
  putLlmConfig: vi.fn(),
  putSecret: vi.fn(),
}));

const setupAdmin = vi.mocked(setupLib.setupAdmin);
const setupBusiness = vi.mocked(setupLib.setupBusiness);
const completeSetup = vi.mocked(setupLib.completeSetup);
const getGitConfig = vi.mocked(soulLib.getGitConfig);

afterEach(() => {
  vi.clearAllMocks();
});

function gitConfig(remoteConfigured: boolean): soulLib.SoulGitConfig {
  return {
    credentialSet: remoteConfigured,
    status: {
      remoteConfigured,
      ahead: 0,
      behind: 0,
      headSha: null,
      lastSyncError: null,
      lastSyncAt: null,
    },
  };
}

function renderWizard() {
  const Stub = createRemixStub([{ path: "/", Component: () => <SetupRoute /> }]);
  render(<Stub initialEntries={["/"]} />);
}

/** Complete steps 1 (admin) and 2 (business), landing on the LLM step. */
async function advanceToLlmStep(user: ReturnType<typeof userEvent.setup>) {
  setupAdmin.mockResolvedValue(undefined as never);
  setupBusiness.mockResolvedValue(undefined as never);

  await user.type(screen.getByLabelText(/email/i), "admin@example.com");
  await user.type(screen.getByLabelText(/^password/i), "mypassword");
  await user.type(screen.getByLabelText(/confirm password/i), "mypassword");
  await user.click(screen.getByRole("button", { name: "Continue" }));

  await user.type(await screen.findByLabelText(/business name/i), "Oscorp");
  await user.click(screen.getByRole("button", { name: "Continue" }));

  await screen.findByRole("heading", { name: "LLM setup" });
}

test("shows all four steps (incl. Soul backup) when no git remote is configured", async () => {
  const user = userEvent.setup();
  getGitConfig.mockResolvedValue(gitConfig(false));
  renderWizard();

  await advanceToLlmStep(user);
  await user.click(screen.getByRole("button", { name: /Skip for now/ }));

  expect(await screen.findByRole("heading", { name: "Soul backup" })).toBeInTheDocument();
  expect(completeSetup).not.toHaveBeenCalled();
});

test("hides the Soul backup step and finishes after LLM when the remote is env-configured", async () => {
  const user = userEvent.setup();
  getGitConfig.mockResolvedValue(gitConfig(true));
  completeSetup.mockResolvedValue(undefined as never);
  renderWizard();

  await advanceToLlmStep(user);
  // Indicator no longer offers the Soul backup step.
  expect(screen.queryByText("Soul backup")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /Skip for now/ }));
  await waitFor(() => expect(completeSetup).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("heading", { name: "Soul backup" })).not.toBeInTheDocument();
});

test("falls back to showing the Soul backup step when the git status probe fails", async () => {
  const user = userEvent.setup();
  getGitConfig.mockRejectedValue(new Error("network down"));
  renderWizard();

  await advanceToLlmStep(user);
  await user.click(screen.getByRole("button", { name: /Skip for now/ }));

  expect(await screen.findByRole("heading", { name: "Soul backup" })).toBeInTheDocument();
  expect(completeSetup).not.toHaveBeenCalled();
});
