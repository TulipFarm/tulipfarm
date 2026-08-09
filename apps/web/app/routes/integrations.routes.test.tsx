import * as remix from "@remix-run/react";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";
import { ErrorBoundary as DetailErrorBoundary } from "./_app.integrations.$name";

// Route smoke test for the integration detail ErrorBoundary — mock useRouteError and render
// directly (the states have no <Link>, so no router context is needed).

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return {
    ...actual,
    useRouteError: vi.fn(),
  };
});

function renderError(node: ReactElement, error: unknown) {
  vi.mocked(remix.useRouteError).mockReturnValue(error);
  render(node);
}

test("detail ErrorBoundary renders 404 not found for a missing integration", () => {
  renderError(<DetailErrorBoundary />, new ApiError(404, "not found"));
  expect(screen.getByText(/404 not found/i)).toBeInTheDocument();
  expect(screen.queryByText(/could not be reached/i)).not.toBeInTheDocument();
});

test("detail ErrorBoundary surfaces a non-404 API failure generically", () => {
  renderError(<DetailErrorBoundary />, new ApiError(500, "boom"));
  expect(screen.getByText(/error: 500/i)).toBeInTheDocument();
  expect(screen.getByText(/could not complete this request/i)).toBeInTheDocument();
});
