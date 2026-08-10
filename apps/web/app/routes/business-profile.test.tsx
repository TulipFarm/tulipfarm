import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";
import * as settings from "~/lib/settings";
import BusinessProfilePage from "./_app.business.profile";

/*
 * The identity block in soul.yaml. It was write-once during /setup for the whole life of the
 * product; this page exists so it can be corrected.
 */

let admin = true;

vi.mock("~/lib/use-session-user", () => ({
  useSessionUser: () => ({ id: "u1", email: "a@b.dev", name: null, role: "admin" }),
  useIsAdmin: () => admin,
}));

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return {
    ...actual,
    useLoaderData: vi.fn(),
    useRevalidator: vi.fn(() => ({ revalidate: vi.fn(), state: "idle" })),
  };
});

vi.mock("~/lib/settings", async () => {
  const actual = await vi.importActual<typeof settings>("~/lib/settings");
  return { ...actual, putBusinessProfile: vi.fn().mockResolvedValue(undefined) };
});

const PROFILE = {
  name: "Fernwood Roasters",
  description: "Speciality coffee wholesale.",
  website: "https://fernwood.coffee",
};

function renderPage(profile = PROFILE) {
  vi.mocked(remix.useLoaderData).mockReturnValue({ profile });
  const Stub = createRemixStub([{ path: "/", Component: BusinessProfilePage }]);
  render(<Stub initialEntries={["/"]} />);
}

beforeEach(() => {
  admin = true;
});

afterEach(() => {
  vi.clearAllMocks();
});

test("saves only after an edit, and trims what it sends", async () => {
  renderPage();

  const save = screen.getByRole("button", { name: /^save$/i });
  expect(save).toBeDisabled();

  const name = screen.getByLabelText("Name");
  await userEvent.clear(name);
  await userEvent.type(name, "  Fernwood Coffee Co  ");
  await userEvent.click(save);

  await waitFor(() =>
    expect(settings.putBusinessProfile).toHaveBeenCalledWith({
      name: "Fernwood Coffee Co",
      description: "Speciality coffee wholesale.",
      website: "https://fernwood.coffee",
    })
  );
});

test("a non-admin reads the profile but cannot edit it", () => {
  admin = false;
  renderPage();

  expect(screen.getByText("Fernwood Roasters")).toBeInTheDocument();
  expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^save$/i })).not.toBeInTheDocument();
});

test("a rejected save reports the API's reason", async () => {
  vi.mocked(settings.putBusinessProfile).mockRejectedValueOnce(new ApiError(403, "forbidden"));
  renderPage();

  await userEvent.type(screen.getByLabelText("Name"), "!");
  await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

  expect(await screen.findByRole("alert")).toHaveTextContent(/only an admin/i);
});
