import { useLocation } from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, getSession, login, type SessionUser } from "~/lib/api";
import { getSetupStatus } from "~/lib/setup";
import { clientLoader } from "./_app";
import Login from "./login";

vi.mock("~/lib/api", async (original) => ({
  ...(await original<typeof import("~/lib/api")>()),
  getSession: vi.fn(),
  login: vi.fn(),
}));
vi.mock("~/lib/setup", () => ({ getSetupStatus: vi.fn() }));
vi.mock("~/components/app-sidebar", () => ({ AppShell: () => null }));
vi.mock("~/components/onboarding/companion", () => ({ OnboardingCompanion: () => null }));

const user: SessionUser = {
  id: "user-1",
  email: "muskan@example.com",
  name: "Muskan Vijayvargiya",
  role: "member",
  status: "active",
  navigation: { visiblePaths: [] },
};

function Destination() {
  const location = useLocation();
  return <output data-testid="destination">{location.pathname + location.search}</output>;
}

async function signIn(entry: string) {
  const Router = createRemixStub([
    { path: "/login", Component: Login },
    { path: "*", Component: Destination },
  ]);
  render(<Router initialEntries={[entry]} />);
  fireEvent.change(screen.getByLabelText("email"), { target: { value: user.email } });
  fireEvent.change(screen.getByLabelText("password"), {
    target: { value: "not-a-real-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(screen.getByTestId("destination")).toBeInTheDocument());
  return screen.getByTestId("destination").textContent;
}

describe("sign-in return destination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSetupStatus).mockResolvedValue({ needsSetup: false });
    vi.mocked(getSession).mockRejectedValue(new ApiError(401, "unauthorized"));
    vi.mocked(login).mockResolvedValue(user);
  });
  afterEach(cleanup);

  it("preserves the Connection origin and Chat return path through the auth gate and login", async () => {
    const destination =
      "/business/connections/new?origin=https%3A%2F%2Fapi.example.com&returnTo=%2Fchats%2Fchat-1";
    const response: unknown = await clientLoader({
      request: new Request(`http://localhost:4000${destination}`),
      params: {},
      serverLoader: vi.fn(),
    }).catch((error: unknown) => error);
    if (!(response instanceof Response)) throw new Error("expected a sign-in redirect");
    expect(response.status).toBe(302);
    const location = response.headers.get("Location");
    if (location === null) throw new Error("missing sign-in destination");
    expect(new URL(location, "http://localhost:4000").searchParams.get("redirectTo")).toBe(
      destination
    );
    expect(await signIn(location)).toBe(destination);
  });

  it.each(["https://outside.example", "//outside.example", "/\\outside.example"])(
    "does not follow an external destination %s",
    async (destination) => {
      expect(await signIn(`/login?redirectTo=${encodeURIComponent(destination)}`)).toBe("/");
    }
  );
});
