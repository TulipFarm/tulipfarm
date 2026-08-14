import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { SessionUser } from "~/lib/api";
import * as apiLib from "~/lib/api";
import { ApiError } from "~/lib/api";
import AppearanceSettings from "./_app.settings.appearance";
import ProfileSettings from "./_app.settings.profile";

/*
 * The personal half of Settings: a record you own (profile), a device preference (appearance).
 * Nothing here is workspace configuration — that moved to /business/*.
 */

let sessionUser: SessionUser | null = null;

vi.mock("~/lib/use-session-user", () => ({
  useSessionUser: () => sessionUser,
  useIsAdmin: () => sessionUser?.role === "admin",
}));

vi.mock("~/lib/api", async () => {
  const actual = await vi.importActual<typeof apiLib>("~/lib/api");
  return { ...actual, updateProfile: vi.fn().mockResolvedValue(undefined) };
});

const updateProfile = vi.mocked(apiLib.updateProfile);

function renderRoute(node: ReactElement) {
  const Stub = createRemixStub([{ path: "/", Component: () => node }]);
  render(<Stub initialEntries={["/"]} />);
}

beforeEach(() => {
  sessionUser = {
    id: "u1",
    email: "rhea@acme.dev",
    name: null,
    role: "member",
    status: "active",
  } as SessionUser;
});

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

test("shows administered identity as facts, not as editable inputs", () => {
  renderRoute(<ProfileSettings />);
  expect(screen.getByText("rhea@acme.dev")).toBeInTheDocument();
  expect(screen.getByText("member")).toBeInTheDocument();
  // Email and role are administered — offering an input the server would refuse is worse than
  // showing the value plainly.
  expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/role/i)).not.toBeInTheDocument();
});

test("saving an empty display name clears it rather than storing whitespace", async () => {
  sessionUser = { ...(sessionUser as SessionUser), name: "Rhea" };
  renderRoute(<ProfileSettings />);

  const input = screen.getByLabelText("Name");
  await userEvent.clear(input);
  await userEvent.type(input, "   ");
  await userEvent.click(screen.getByRole("button", { name: /^save/i }));

  expect(updateProfile).toHaveBeenCalledWith(null);
});

test("the save action stays inert until the name actually changes", async () => {
  sessionUser = { ...(sessionUser as SessionUser), name: "Rhea" };
  renderRoute(<ProfileSettings />);

  expect(screen.getByRole("button", { name: /^save/i })).toBeDisabled();
  await userEvent.type(screen.getByLabelText("Name"), " Patel");
  expect(screen.getByRole("button", { name: /^save/i })).toBeEnabled();
});

test("a failed save reports the API's reason instead of a generic error", async () => {
  updateProfile.mockRejectedValueOnce(new ApiError(422, "name is too long"));
  renderRoute(<ProfileSettings />);

  await userEvent.type(screen.getByLabelText("Name"), "Rhea");
  await userEvent.click(screen.getByRole("button", { name: /^save/i }));

  expect(await screen.findByRole("alert")).toHaveTextContent("name is too long");
});

test("theme is a three-way preference, with system as its own choice", async () => {
  renderRoute(<AppearanceSettings />);

  const system = screen.getByRole("radio", { name: /system/i });
  await waitFor(() => expect(system).toBeChecked());

  await userEvent.click(screen.getByRole("radio", { name: /dark/i }));
  expect(localStorage.getItem("theme")).toBe("dark");
  expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

  // Returning to System stores the intent to follow the device, not a resolved colour.
  await userEvent.click(system);
  expect(localStorage.getItem("theme")).toBe("system");
});
