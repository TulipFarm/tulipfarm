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
  renderError(new ApiError(0, "network down"));

  expect(screen.getByText(/error: /)).toBeInTheDocument();
  expect(
    screen.getByText("The API could not be reached. Check that it is running on :4010.")
  ).toBeInTheDocument();
});

test.each([
  new Error('Module "node:crypto" has been externalized for browser compatibility.'),
  new TypeError("Cannot read properties of undefined"),
  new SyntaxError("Unexpected token"),
])("does not blame the API for a JavaScript error: %s", (error) => {
  renderError(error);

  expect(screen.getByText(`error: ${error.message}`)).toBeInTheDocument();
  expect(screen.queryByText(/The API/)).not.toBeInTheDocument();
  expect(screen.getByText("This page could not be loaded. Try reloading it.")).toBeInTheDocument();
});

test.each([
  new Response("Forbidden", { status: 403, statusText: "Forbidden" }),
  { status: 403, statusText: "Forbidden", data: "Forbidden", internal: false },
])("preserves route response status without claiming a transport failure", (error) => {
  renderError(error);

  expect(screen.getByText(/error: 403/)).toBeInTheDocument();
  expect(screen.queryByText(/could not be reached/)).not.toBeInTheDocument();
});

test("still reports a typed ApiError with its status", () => {
  renderError(new ApiError(503, "api unreachable"));

  expect(screen.getByText(/error: 503/)).toBeInTheDocument();
});
