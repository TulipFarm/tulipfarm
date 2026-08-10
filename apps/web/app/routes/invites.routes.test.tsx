import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import * as apiLib from "~/lib/api";
import { ApiError } from "~/lib/api";
import * as usersLib from "~/lib/users";
import PeopleRoute from "./_app.business.people";
import AuthSettings from "./_app.settings.auth";
import AcceptInvite from "./accept-invite";

/*
 * Invite provisioning and password change, end to end at the UI seam: the admin page issues links
 * it shows exactly once, the acceptance page redeems a token it reads from the URL *fragment*
 * (never the query string), and the Settings form requires the current password.
 */

vi.mock("~/lib/users", async () => {
  const actual = await vi.importActual<typeof usersLib>("~/lib/users");
  return {
    ...actual,
    listUsers: vi.fn(),
    createUser: vi.fn(),
    reissueInvite: vi.fn(),
    setUserStatus: vi.fn(),
  };
});
vi.mock("~/lib/api", async () => {
  const actual = await vi.importActual<typeof apiLib>("~/lib/api");
  return {
    ...actual,
    previewInvite: vi.fn(),
    acceptInvite: vi.fn(),
    changePassword: vi.fn(),
  };
});
vi.mock("~/lib/clipboard", () => ({ copyText: vi.fn().mockResolvedValue(true) }));
// The Auth page also lists API tokens; stub that fetch so it cannot colour the password assertions.
vi.mock("~/lib/settings", async () => {
  const actual = await vi.importActual<typeof import("~/lib/settings")>("~/lib/settings");
  return { ...actual, listApiTokens: vi.fn().mockResolvedValue([]) };
});

const listUsers = vi.mocked(usersLib.listUsers);
const createUser = vi.mocked(usersLib.createUser);
const reissueInvite = vi.mocked(usersLib.reissueInvite);
const previewInvite = vi.mocked(apiLib.previewInvite);
const acceptInvite = vi.mocked(apiLib.acceptInvite);
const changePassword = vi.mocked(apiLib.changePassword);

const EXPIRES = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();

afterEach(() => {
  vi.clearAllMocks();
  window.location.hash = "";
});

function user(overrides: Partial<usersLib.UserSummary> = {}): usersLib.UserSummary {
  return {
    id: "u1",
    email: "member@example.com",
    name: null,
    role: "member",
    status: "active",
    ...overrides,
  };
}

function renderAdmin() {
  const Stub = createRemixStub([
    {
      path: "/business/people",
      Component: PeopleRoute,
      loader: async () => ({ users: await listUsers() }),
    },
  ]);
  return render(<Stub initialEntries={["/business/people"]} />);
}

test("inviting a user shows a copyable link carrying the token in the fragment", async () => {
  listUsers.mockResolvedValue([]);
  createUser.mockResolvedValue({
    user: user({ email: "new@example.com", status: "invited" }),
    invite: { token: "tok-123", expiresAt: EXPIRES },
  });

  renderAdmin();
  await userEvent.type(await screen.findByLabelText("Email"), "new@example.com");
  await userEvent.click(screen.getByRole("button", { name: "Send invite" }));

  const link = await screen.findByText(/\/accept-invite#token=tok-123$/);
  expect(link).toBeTruthy();
  // The token must never sit in the query string, where nginx would log it.
  expect(link.textContent).not.toContain("?token=");
});

test("an invited user offers a new link and an active one offers a reset link", async () => {
  listUsers.mockResolvedValue([
    user({ id: "u1", email: "pending@example.com", status: "invited" }),
    user({ id: "u2", email: "active@example.com", status: "active" }),
  ]);

  renderAdmin();
  expect(await screen.findByText("Invite pending")).toBeTruthy();
  expect(screen.getByRole("button", { name: "New invite link" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Reset password link" })).toBeTruthy();
});

test("re-issuing a link for an active user surfaces it for sharing", async () => {
  listUsers.mockResolvedValue([user({ status: "active" })]);
  reissueInvite.mockResolvedValue({ token: "tok-fresh", expiresAt: EXPIRES });

  renderAdmin();
  await userEvent.click(await screen.findByRole("button", { name: "Reset password link" }));

  await waitFor(() => expect(reissueInvite).toHaveBeenCalledWith("u1"));
  expect(await screen.findByText(/#token=tok-fresh$/)).toBeTruthy();
});

test("a disabled user offers no invite link", async () => {
  listUsers.mockResolvedValue([user({ status: "disabled" })]);

  renderAdmin();
  expect(await screen.findByText("Disabled")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "New invite link" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Reset password link" })).toBeNull();
  expect(screen.getByRole("button", { name: "Enable" })).toBeTruthy();
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

test("changing a password sends the current one alongside the new", async () => {
  changePassword.mockResolvedValue({
    id: "u1",
    email: "member@example.com",
    name: null,
    role: "member",
    status: "active",
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
