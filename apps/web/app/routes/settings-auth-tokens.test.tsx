import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import * as settings from "~/lib/settings";
import AuthSettings from "./_app.settings.auth";

/*
 * Personal access tokens. The backend has supported these since the auth module landed and nothing
 * in the product ever called them — these tests pin the one moment the secret is visible.
 */

vi.mock("~/lib/settings", async () => {
  const actual = await vi.importActual<typeof settings>("~/lib/settings");
  return {
    ...actual,
    listApiTokens: vi.fn().mockResolvedValue([]),
    createApiToken: vi.fn(),
    revokeApiToken: vi.fn().mockResolvedValue(undefined),
  };
});

const listApiTokens = vi.mocked(settings.listApiTokens);
const createApiToken = vi.mocked(settings.createApiToken);
const revokeApiToken = vi.mocked(settings.revokeApiToken);

const TOKEN = {
  id: "t1",
  userId: "u1",
  name: "CI runner",
  prefix: "tf_9f2a",
  createdAt: "2026-02-11T09:00:00.000Z",
};

afterEach(() => {
  vi.clearAllMocks();
  listApiTokens.mockResolvedValue([]);
});

test("says so plainly when no token exists rather than showing an empty list", async () => {
  render(<AuthSettings />);
  expect(await screen.findByText("No tokens yet.")).toBeInTheDocument();
});

test("shows a created token once, and lists only its prefix afterwards", async () => {
  createApiToken.mockResolvedValue({ ...TOKEN, token: "tf_9f2a_secret_value" });
  render(<AuthSettings />);

  await userEvent.type(await screen.findByLabelText("New token name"), "CI runner");
  await userEvent.click(screen.getByRole("button", { name: /^create$/i }));

  // The full secret appears exactly once, in a copyable field.
  expect(await screen.findByText("tf_9f2a_secret_value")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Copy API token CI runner" })).toBeInTheDocument();
  // The stored record carries only the prefix — the row can never re-reveal the secret.
  expect(screen.getByText("tf_9f2a…")).toBeInTheDocument();
  expect(createApiToken).toHaveBeenCalledWith("CI runner");
});

test("an unnamed token is never created", async () => {
  render(<AuthSettings />);

  await userEvent.type(await screen.findByLabelText("New token name"), "   ");

  // A whitespace-only name is not a name; the action stays inert rather than creating a token
  // nobody could later identify.
  expect(screen.getByRole("button", { name: /^create$/i })).toBeDisabled();
  expect(createApiToken).not.toHaveBeenCalled();
});

test("revoking a token removes it from the list", async () => {
  listApiTokens.mockResolvedValue([TOKEN]);
  render(<AuthSettings />);

  await userEvent.click(await screen.findByRole("button", { name: "Revoke CI runner" }));

  await waitFor(() => expect(revokeApiToken).toHaveBeenCalledWith("t1"));
  await waitFor(() => expect(screen.queryByText("CI runner")).not.toBeInTheDocument());
});

test("an unreachable token list does not take the password form down with it", async () => {
  listApiTokens.mockRejectedValue(new Error("network"));
  render(<AuthSettings />);

  expect(await screen.findByLabelText("Current password")).toBeInTheDocument();
  expect(await screen.findByRole("alert")).toBeInTheDocument();
});
