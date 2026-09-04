import type { ClientLoaderFunctionArgs } from "@remix-run/react";
import * as remix from "@remix-run/react";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as api from "~/lib/api";
import { ApiError } from "~/lib/api";
import * as setup from "~/lib/setup";
import { clientLoader, ErrorBoundary } from "./_app";

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return { ...actual, useRouteError: vi.fn() };
});

vi.mock("~/lib/setup", () => ({ getSetupStatus: vi.fn() }));
vi.mock("~/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/api")>()),
  getSession: vi.fn(),
}));

const getSetupStatus = vi.mocked(setup.getSetupStatus);
const getSession = vi.mocked(api.getSession);

beforeEach(() => {
  getSetupStatus.mockResolvedValue({ needsSetup: false });
  getSession.mockRejectedValue(new ApiError(401, "unauthenticated"));
});

afterEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/");
});

/**
 * `browserPath` is what the address bar still reads while the gate runs; `requestPath` is the
 * destination Remix is actually loading. They differ during a redirect hop, which is the whole
 * point of these cases.
 */
async function runGate(browserPath: string, requestPath: string): Promise<Response> {
  window.history.replaceState({}, "", browserPath);
  const args = {
    request: new Request(new URL(requestPath, "http://localhost")),
    params: {},
  } as unknown as ClientLoaderFunctionArgs;
  try {
    await clientLoader(args);
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
  throw new Error("expected the gate to redirect");
}

test("sends an unauthenticated visitor to login carrying the path they asked for", async () => {
  const response = await runGate("/chats", "/chats");

  expect(response.headers.get("Location")).toBe("/login?redirectTo=%2Fchats");
});

test("captures the destination being loaded, not the URL the browser is still showing", async () => {
  // The /setup gate has already thrown redirect("/"), so Remix is loading "/" while the address
  // bar still reads "/setup" — history only commits after the loaders resolve.
  const response = await runGate("/setup", "/");

  expect(response.headers.get("Location")).toBe("/login?redirectTo=%2F");
});

test("sends a never-provisioned instance to the wizard before it considers auth", async () => {
  getSetupStatus.mockResolvedValue({ needsSetup: true });

  const response = await runGate("/chats", "/chats");

  expect(response.headers.get("Location")).toBe("/setup");
});

test("rethrows a non-401 session failure instead of masking it as a login bounce", async () => {
  getSession.mockRejectedValue(new ApiError(503, "api unreachable"));

  await expect(runGate("/chats", "/chats")).rejects.toThrow("api unreachable");
});

test("renders an API recovery state instead of Remix's raw Application Error", () => {
  vi.mocked(remix.useRouteError).mockReturnValue(new TypeError("Failed to fetch"));

  render(<ErrorBoundary />);

  expect(screen.getByRole("heading", { level: 1, name: "TulipFarm" })).toBeInTheDocument();
  expect(screen.getByText("error: Failed to fetch")).toBeInTheDocument();
  expect(
    screen.getByText("The API could not be reached. Check that it is running on :4010.")
  ).toBeInTheDocument();
});
