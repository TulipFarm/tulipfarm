import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";
import * as setupLib from "~/lib/setup";
import SetupRoute from "./setup";

vi.mock("~/lib/setup", () => ({
  getSetupStatus: vi.fn(),
  setupAdmin: vi.fn(),
  setupBusiness: vi.fn(),
  completeSetup: vi.fn(),
}));

const setupAdmin = vi.mocked(setupLib.setupAdmin);
const setupBusiness = vi.mocked(setupLib.setupBusiness);
const completeSetup = vi.mocked(setupLib.completeSetup);

afterEach(() => {
  vi.clearAllMocks();
});

function renderRoute(telemetry = { maxLevel: 2, enabled: true }) {
  const Stub = createRemixStub([
    { path: "/", Component: () => <SetupRoute />, loader: () => ({ telemetry }) },
  ]);
  render(<Stub initialEntries={["/"]} hydrationData={{ loaderData: { "0": { telemetry } } }} />);
}

async function answerAll(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/what should we call you/i), "Ada Lovelace");
  await user.click(screen.getByRole("button", { name: "Continue" }));

  await user.type(await screen.findByLabelText(/^email/i), "admin@example.com");
  await user.click(screen.getByRole("button", { name: "Continue" }));

  await user.type(await screen.findByLabelText(/^password/i), "mypassword");
  await user.click(screen.getByRole("button", { name: "Continue" }));

  await user.type(await screen.findByLabelText(/what's your business called/i), "Acme Tulips");
}

test("creates the admin, records the business, then completes setup", async () => {
  const user = userEvent.setup();
  setupAdmin.mockResolvedValue(undefined as never);
  setupBusiness.mockResolvedValue(undefined as never);
  completeSetup.mockResolvedValue(undefined as never);
  renderRoute();

  await answerAll(user);
  await user.click(screen.getByRole("button", { name: "Finish" }));

  await waitFor(() =>
    expect(setupAdmin).toHaveBeenCalledWith("Ada Lovelace", "admin@example.com", "mypassword")
  );
  expect(setupBusiness).toHaveBeenCalledWith("Acme Tulips", "", "");
  expect(completeSetup).toHaveBeenCalledTimes(1);
});

test("does not call the API until the last question is answered", async () => {
  const user = userEvent.setup();
  renderRoute();

  await answerAll(user);

  expect(setupAdmin).not.toHaveBeenCalled();
});

test("steps back to an earlier question without losing what was already typed", async () => {
  const user = userEvent.setup();
  renderRoute();

  await user.type(screen.getByLabelText(/what should we call you/i), "Ada Lovelace");
  await user.click(screen.getByRole("button", { name: "Continue" }));

  await screen.findByLabelText(/^email/i);
  await user.click(screen.getByRole("button", { name: "Back" }));

  expect(await screen.findByLabelText(/what should we call you/i)).toHaveValue("Ada Lovelace");
});

test("disables Continue until the current question has a value", async () => {
  renderRoute();

  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
});

test("requires at least 8 characters for the password", async () => {
  const user = userEvent.setup();
  renderRoute();

  await user.type(screen.getByLabelText(/what should we call you/i), "Ada Lovelace");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.type(await screen.findByLabelText(/^email/i), "admin@example.com");
  await user.click(screen.getByRole("button", { name: "Continue" }));

  await user.type(await screen.findByLabelText(/^password/i), "short");

  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
});

test("does not replay admin creation when the business step fails", async () => {
  const user = userEvent.setup();
  setupAdmin.mockResolvedValue(undefined as never);
  setupBusiness
    .mockRejectedValueOnce(new ApiError(400, "name is required"))
    .mockResolvedValue(undefined as never);
  completeSetup.mockResolvedValue(undefined as never);
  renderRoute();

  await answerAll(user);
  await user.click(screen.getByRole("button", { name: "Finish" }));

  expect(await screen.findByText("name is required")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Finish" }));

  // A second admin call would 403 — setup would be unrecoverable without a database reset.
  await waitFor(() => expect(completeSetup).toHaveBeenCalledTimes(1));
  expect(setupAdmin).toHaveBeenCalledTimes(1);
  expect(setupBusiness).toHaveBeenCalledTimes(2);
});

test("rewinds to the question named by a 422's field path", async () => {
  const user = userEvent.setup();
  setupAdmin.mockRejectedValue(new ApiError(422, "email is already taken", "email"));
  renderRoute();

  await answerAll(user);
  await user.click(screen.getByRole("button", { name: "Finish" }));

  expect(await screen.findByText("email is already taken")).toBeInTheDocument();
  expect(screen.getByLabelText(/^email/i)).toBeInTheDocument();
});

test("discloses mandatory bootstrap and submits the selected telemetry level", async () => {
  setupAdmin.mockResolvedValue(undefined);
  setupBusiness.mockResolvedValue(undefined);
  completeSetup.mockResolvedValue(undefined);
  const user = userEvent.setup();
  renderRoute();
  await answerAll(user);
  expect(screen.getByText(/mandatory one-time bootstrap report/i)).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: /Level 2/ })).toBeChecked();
  await user.click(screen.getByRole("radio", { name: /Level 0/ }));
  await user.click(screen.getByRole("button", { name: "Finish" }));
  await waitFor(() => expect(completeSetup).toHaveBeenCalledWith(0));
});

test("setup respects the deployment cap and discloses disabled delivery", async () => {
  const user = userEvent.setup();
  renderRoute({ maxLevel: 1, enabled: false });
  await answerAll(user);
  expect(screen.getByRole("radio", { name: /Level 1/ })).toBeChecked();
  expect(screen.getByRole("radio", { name: /Level 2/ })).toBeDisabled();
  expect(screen.getByText(/disabled in development and tests/i)).toBeInTheDocument();
});
