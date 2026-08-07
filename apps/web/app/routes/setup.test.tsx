import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import * as setupLib from "~/lib/setup";
import SetupRoute from "./setup";

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

afterEach(() => {
  vi.clearAllMocks();
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
