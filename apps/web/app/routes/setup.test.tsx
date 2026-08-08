import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { deriveModelProfiles, resolveEffortPreset, validateLlmConfig } from "@tulipfarm/schema";
import { afterEach, expect, test, vi } from "vitest";
import * as settingsLib from "~/lib/settings";
import * as setupLib from "~/lib/setup";
import SetupRoute, { buildSetupLlmConfig } from "./setup";

/*
 * Setup wizard flow tests. The wizard is three steps — admin account, business profile, LLM setup
 * — and completing (or skipping) the last one finishes setup. Drafts live in the route so stepping
 * back never discards typed input.
 */

vi.mock("~/lib/setup", () => ({
  getSetupStatus: vi.fn(),
  setupAdmin: vi.fn(),
  setupBusiness: vi.fn(),
  completeSetup: vi.fn(),
}));
vi.mock("~/lib/settings", () => ({
  listProviders: vi.fn().mockResolvedValue([]),
  putLlmConfig: vi.fn(),
  putSecret: vi.fn(),
}));

const setupAdmin = vi.mocked(setupLib.setupAdmin);
const setupBusiness = vi.mocked(setupLib.setupBusiness);
const completeSetup = vi.mocked(setupLib.completeSetup);
const listProviders = vi.mocked(settingsLib.listProviders);
const putLlmConfig = vi.mocked(settingsLib.putLlmConfig);
const putSecret = vi.mocked(settingsLib.putSecret);

afterEach(() => {
  vi.clearAllMocks();
  listProviders.mockResolvedValue([]);
});

function renderWizard() {
  const Stub = createRemixStub([{ path: "/", Component: () => <SetupRoute /> }]);
  render(<Stub initialEntries={["/"]} />);
}

/** Complete steps 1 (admin) and 2 (business), landing on the LLM step. */
async function advanceToLlmStep(
  user: ReturnType<typeof userEvent.setup>,
  business: { website?: string } = {}
) {
  setupAdmin.mockResolvedValue(undefined as never);
  setupBusiness.mockResolvedValue(undefined as never);

  await user.type(screen.getByLabelText(/email/i), "admin@example.com");
  await user.type(screen.getByLabelText(/^password/i), "mypassword");
  await user.type(screen.getByLabelText(/confirm password/i), "mypassword");
  await user.click(screen.getByRole("button", { name: "Continue" }));

  await user.type(await screen.findByLabelText(/business name/i), "Oscorp");
  if (business.website) await user.type(screen.getByLabelText(/website/i), business.website);
  await user.click(screen.getByRole("button", { name: "Continue" }));

  await screen.findByRole("heading", { name: "LLM setup" });
}

test("finishes setup when the final LLM step is skipped", async () => {
  const user = userEvent.setup();
  completeSetup.mockResolvedValue(undefined as never);
  renderWizard();

  await advanceToLlmStep(user);
  await user.click(screen.getByRole("button", { name: /Skip for now/ }));

  await waitFor(() => expect(completeSetup).toHaveBeenCalledTimes(1));
});

test("sends the optional website with the business profile", async () => {
  const user = userEvent.setup();
  renderWizard();

  await advanceToLlmStep(user, { website: "https://oscorp.example" });

  expect(setupBusiness).toHaveBeenCalledWith("Oscorp", "", "https://oscorp.example");
});

test("omits the website when it is left blank", async () => {
  const user = userEvent.setup();
  renderWizard();

  await advanceToLlmStep(user);

  expect(setupBusiness).toHaveBeenCalledWith("Oscorp", "", "");
});

test("steps back to an earlier step without losing what was already typed", async () => {
  const user = userEvent.setup();
  renderWizard();

  await advanceToLlmStep(user);
  const model = screen.getByLabelText(/^model/i);
  await user.clear(model);
  await user.type(model, "claude-haiku-4-5");

  await user.click(screen.getByRole("button", { name: "Back" }));

  expect(await screen.findByRole("heading", { name: "Business profile" })).toBeInTheDocument();
  expect(screen.getByLabelText(/business name/i)).toHaveValue("Oscorp");

  await user.click(screen.getByRole("button", { name: "Continue" }));

  await screen.findByRole("heading", { name: "LLM setup" });
  expect(screen.getByLabelText(/^model/i)).toHaveValue("claude-haiku-4-5");
}, 15_000);

test("submits tiers and an explicit default effort preset map from LLM setup", async () => {
  const user = userEvent.setup();
  const seededConfig = buildSetupLlmConfig("anthropic", "claude-sonnet-4-6");
  listProviders.mockResolvedValue([
    {
      id: "anthropic",
      label: "Anthropic",
      fields: [
        {
          key: "ANTHROPIC_API_KEY",
          label: "Anthropic API key",
          role: "api_key",
          kind: "secret",
        },
      ],
    },
  ]);
  putLlmConfig.mockResolvedValue(seededConfig);
  putSecret.mockResolvedValue(undefined as never);
  completeSetup.mockResolvedValue(undefined as never);
  renderWizard();

  await advanceToLlmStep(user);
  await user.type(await screen.findByLabelText(/anthropic api key/i), "sk-test");
  await user.click(screen.getByRole("button", { name: "Continue" }));

  await waitFor(() => expect(putLlmConfig).toHaveBeenCalledTimes(1));
  expect(putLlmConfig).toHaveBeenCalledWith({
    tiers: {
      quick: { providers: [{ provider: "anthropic", model: "claude-sonnet-4-6" }] },
      standard: { providers: [{ provider: "anthropic", model: "claude-sonnet-4-6" }] },
      complex: { providers: [{ provider: "anthropic", model: "claude-sonnet-4-6" }] },
    },
    presets: { default: "balanced" },
  });
});

test("seeds a schema-valid LLM config where auto resolves to a derived profile", () => {
  const config = validateLlmConfig(buildSetupLlmConfig("anthropic", "claude-sonnet-4-6"));
  const profiles = deriveModelProfiles(config);
  const available = new Set(profiles.map((profile) => profile.profileId));
  const resolved = resolveEffortPreset("auto", config, (profileId) => available.has(profileId));

  expect(resolved).toBe("balanced");
  expect(profiles.find((profile) => profile.profileId === resolved)).toMatchObject({
    profileId: "balanced",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
  });
});

/*
 * The installer browser smoke (scripts/test/browser-smoke.mjs) fills this field by id rather than
 * by placeholder, after rewriting the placeholder copy silently broke it. Renaming the id would
 * otherwise only surface in the slow Docker installer stage, so pin the contract here instead.
 */
test("keeps the business-name field id the installer browser smoke drives", async () => {
  const user = userEvent.setup();
  setupAdmin.mockResolvedValue(undefined as never);
  renderWizard();

  await user.type(screen.getByLabelText(/email/i), "admin@example.com");
  await user.type(screen.getByLabelText(/^password/i), "mypassword");
  await user.type(screen.getByLabelText(/confirm password/i), "mypassword");
  await user.click(screen.getByRole("button", { name: "Continue" }));

  expect(await screen.findByLabelText(/business name/i)).toHaveAttribute(
    "id",
    "setup-business-name"
  );
});
