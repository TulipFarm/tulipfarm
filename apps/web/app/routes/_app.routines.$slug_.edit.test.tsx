import * as remix from "@remix-run/react";
import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";
import { ErrorBoundary } from "./_app.routines.$slug_.edit";

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return { ...actual, useRouteError: vi.fn() };
});

function renderError(error: unknown) {
  vi.mocked(remix.useRouteError).mockReturnValue(error);
  render(<ErrorBoundary />);
}

test("a 404 from the authoring endpoint states the boundary explicitly instead of a dead end", () => {
  renderError(new ApiError(404, "Not Found"));

  expect(screen.getByText(/Authoring is not available for this Routine/)).toBeInTheDocument();
  expect(screen.queryByText(/The API responded, but could not complete this request\./)).toBeNull();
});

test("a non-404 authoring failure still reports through the generic error state", () => {
  renderError(new ApiError(500, "boom"));

  expect(screen.getByText(/error: 500/)).toBeInTheDocument();
  expect(
    screen.getByText("The API responded, but could not complete this request.")
  ).toBeInTheDocument();
});
