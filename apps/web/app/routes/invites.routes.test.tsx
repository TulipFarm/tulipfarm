import { createRemixStub } from "@remix-run/testing";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import * as apiLib from "~/lib/api";
import { ApiError } from "~/lib/api";
import AuthSettings from "./_app.settings.auth";
import AcceptInvite from "./accept-invite";

/*
 * Invite redemption and password change, end to end at the UI seam: the acceptance page redeems
 * a token it reads from the URL *fragment* (never the query string), and the Settings form
 * requires the current password.
 */

vi.mock("~/lib/api", async () => {
  const actual = await vi.importActual<typeof apiLib>("~/lib/api");
  return {
    ...actual,
    previewInvite: vi.fn(),
    acceptInvite: vi.fn(),
    changePassword: vi.fn(),
  };
});
vi.mock("~/lib/settings", async () => {
  const actual = await vi.importActual<typeof import("~/lib/settings")>("~/lib/settings");
  return { ...actual, listApiTokens: vi.fn().mockResolvedValue([]) };
});

const previewInvite = vi.mocked(apiLib.previewInvite);
const acceptInvite = vi.mocked(apiLib.acceptInvite);
const changePassword = vi.mocked(apiLib.changePassword);

const EXPIRES = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();

afterEach(() => {
  vi.clearAllMocks();
  window.location.hash = "";
});

function renderAccept() {
  const Stub = createRemixStub([{ path: "/accept-invite", Component: AcceptInvite }]);
  return render(<Stub initialEntries={["/accept-invite"]} />);
}

test("accepting an invite reads the token from the fragment and sets the password", async () => {
  window.location.hash = "#token=tok-123";
  previewInvite.mockResolvedValue({ email: "new@example.com", expiresAt: EXPIRES });
  acceptInvite.mockResolvedValue({
    id: "u1",
    email: "new@example.com",
    name: null,
    role: "member",
    status: "active",
    navigation: { visiblePaths: [] },
  });

  renderAccept();
  expect(await screen.findByText("new@example.com")).toBeTruthy();

  await userEvent.type(screen.getByLabelText("password"), "a-strong-password");
  await userEvent.type(screen.getByLabelText("confirm password"), "a-strong-password");
  await userEvent.click(screen.getByRole("button", { name: /set password/i }));

  await waitFor(() => expect(acceptInvite).toHaveBeenCalledWith("tok-123", "a-strong-password"));
});

test("a spent or expired link explains itself and shows no form", async () => {
  window.location.hash = "#token=tok-dead";
  previewInvite.mockRejectedValue(new ApiError(404, "this invite link is no longer valid"));

  renderAccept();
  expect(await screen.findByRole("alert")).toHaveTextContent("no longer valid");
  expect(screen.queryByLabelText("password")).toBeNull();
});

test("a link with no token is refused without calling the API", async () => {
  renderAccept();
  expect(await screen.findByRole("alert")).toHaveTextContent("missing its invite token");
  expect(previewInvite).not.toHaveBeenCalled();
});

test("mismatched passwords are caught before the API is called", async () => {
  window.location.hash = "#token=tok-123";
  previewInvite.mockResolvedValue({ email: "new@example.com", expiresAt: EXPIRES });

  renderAccept();
  await screen.findByText("new@example.com");
  await userEvent.type(screen.getByLabelText("password"), "a-strong-password");
  await userEvent.type(screen.getByLabelText("confirm password"), "a-different-one");
  await userEvent.click(screen.getByRole("button", { name: /set password/i }));

  expect(await screen.findByRole("alert")).toHaveTextContent("do not match");
  expect(acceptInvite).not.toHaveBeenCalled();
});

test("navigating from a missing-token invite page to a valid fragment runs preview and shows form", async () => {
  previewInvite.mockResolvedValue({ email: "fresh@example.com", expiresAt: EXPIRES });

  renderAccept();
  expect(await screen.findByRole("alert")).toHaveTextContent("missing its invite token");
  expect(previewInvite).not.toHaveBeenCalled();

  act(() => {
    window.location.hash = "#token=tok-new";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });

  expect(await screen.findByText("fresh@example.com")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByLabelText("password")).toBeTruthy();
  expect(previewInvite).toHaveBeenCalledWith("tok-new");
});

test("replacing an invalid or expired token with a valid token updates the mounted page", async () => {
  window.location.hash = "#token=tok-dead";
  previewInvite.mockRejectedValueOnce(new ApiError(404, "this invite link is no longer valid"));

  renderAccept();
  expect(await screen.findByRole("alert")).toHaveTextContent("no longer valid");

  previewInvite.mockResolvedValueOnce({ email: "recovered@example.com", expiresAt: EXPIRES });
  act(() => {
    window.location.hash = "#token=tok-valid";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });

  expect(await screen.findByText("recovered@example.com")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByLabelText("password")).toBeTruthy();
});

test("replacing a valid token clears stale identity, form, and error state", async () => {
  window.location.hash = "#token=tok-1";
  previewInvite.mockResolvedValueOnce({ email: "first@example.com", expiresAt: EXPIRES });

  renderAccept();
  expect(await screen.findByText("first@example.com")).toBeTruthy();

  await userEvent.type(screen.getByLabelText("password"), "initial-pass");
  await userEvent.type(screen.getByLabelText("confirm password"), "mismatched-pass");
  await userEvent.click(screen.getByRole("button", { name: /set password/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent("do not match");

  previewInvite.mockResolvedValueOnce({ email: "second@example.com", expiresAt: EXPIRES });
  act(() => {
    window.location.hash = "#token=tok-2";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });

  expect(await screen.findByText("second@example.com")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect((screen.getByLabelText("password") as HTMLInputElement).value).toBe("");
  expect((screen.getByLabelText("confirm password") as HTMLInputElement).value).toBe("");
});

test("changing a password sends the current one alongside the new", async () => {
  changePassword.mockResolvedValue({
    id: "u1",
    email: "member@example.com",
    name: null,
    role: "member",
    status: "active",
    navigation: { visiblePaths: [] },
  });

  render(<AuthSettings />);
  await userEvent.type(screen.getByLabelText("Current password"), "current-password");
  await userEvent.type(screen.getByLabelText("New password"), "new-strong-password");
  await userEvent.type(screen.getByLabelText("Confirm new password"), "new-strong-password");
  await userEvent.click(screen.getByRole("button", { name: "Change password" }));

  await waitFor(() =>
    expect(changePassword).toHaveBeenCalledWith("current-password", "new-strong-password")
  );
  expect(await screen.findByRole("status")).toHaveTextContent("Password updated");
});

test("a rejected current password surfaces the API error", async () => {
  changePassword.mockRejectedValue(new ApiError(401, "current password is incorrect"));

  render(<AuthSettings />);
  await userEvent.type(screen.getByLabelText("Current password"), "wrong");
  await userEvent.type(screen.getByLabelText("New password"), "new-strong-password");
  await userEvent.type(screen.getByLabelText("Confirm new password"), "new-strong-password");
  await userEvent.click(screen.getByRole("button", { name: "Change password" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("current password is incorrect");
});
