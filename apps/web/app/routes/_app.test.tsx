import * as remix from "@remix-run/react";
import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";
import { ErrorBoundary } from "./_app";

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return { ...actual, useRouteError: vi.fn() };
});

function renderError(error: unknown) {
  vi.mocked(remix.useRouteError).mockReturnValue(error);
  render(<ErrorBoundary />);
}

// A dev-only child route (e.g. /design-guide) gates itself by throwing a bare Response 404 out
// of its clientLoader, never touching the API. The shell boundary must preserve that not-found
// state rather than mistaking the untyped Response for a transport failure.
test("preserves a child route's not-found Response instead of reporting it as a transport failure", () => {
  renderError(new Response("Not found", { status: 404 }));

  expect(screen.getByText("error: 404 not found")).toBeInTheDocument();
  expect(
    screen.getByText("No record matches that id (it may have been deleted).")
  ).toBeInTheDocument();
  expect(screen.queryByText(/could not be reached/)).not.toBeInTheDocument();
});

test("still reports a real API outage as a transport failure", () => {
  renderError(new Error("network down"));

  expect(screen.getByText(/error: /)).toBeInTheDocument();
  expect(
    screen.getByText("The API could not be reached. Check that it is running on :4010.")
  ).toBeInTheDocument();
});

test("still reports a typed ApiError with its status", () => {
  renderError(new ApiError(503, "api unreachable"));

  expect(screen.getByText(/error: 503/)).toBeInTheDocument();
});
