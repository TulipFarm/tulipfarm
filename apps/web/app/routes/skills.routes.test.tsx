import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";
import SkillDetail, { ErrorBoundary as DetailErrorBoundary } from "./_app.skills.$name";
import SkillsIndex from "./_app.skills._index";

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return {
    ...actual,
    useLoaderData: vi.fn(),
    useRouteError: vi.fn(),
    useParams: vi.fn(() => ({})),
  };
});

function renderWithData(node: ReactElement, data: unknown) {
  vi.mocked(remix.useLoaderData).mockReturnValue(data);
  const Stub = createRemixStub([{ path: "/", Component: () => node }]);
  render(<Stub initialEntries={["/"]} />);
}

function renderError(node: ReactElement, error: unknown) {
  vi.mocked(remix.useRouteError).mockReturnValue(error);
  render(node);
}

test("index lists skills with provenance and an Install-from-git entry", () => {
  renderWithData(<SkillsIndex />, {
    skills: [
      {
        name: "demo-skill",
        description: "A demo.",
        provenance: "marketplace",
        source: "owner/repo",
      },
      { name: "my-skill", description: "Mine.", provenance: "user" },
    ],
  });
  expect(screen.getByText("2 skills")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /demo-skill/ })).toHaveAttribute(
    "href",
    "/skills/demo-skill"
  );
  expect(screen.getByText("marketplace")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /install from git/i })).toHaveAttribute(
    "href",
    "/skills/install"
  );
});

test("index with no skills shows the empty state with an install entry", () => {
  renderWithData(<SkillsIndex />, { skills: [] });
  expect(screen.getByText("0 results")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /install from git/i })).toBeInTheDocument();
});

test("detail renders the SKILL.md body and provenance/source", () => {
  renderWithData(<SkillDetail />, {
    skill: {
      name: "demo-skill",
      description: "A demo.",
      provenance: "marketplace",
      source: "owner/repo",
      body: "# Demo\nDoes the demo.",
    },
  });
  expect(screen.getByText("Does the demo.")).toBeInTheDocument();
  expect(screen.getByText("owner/repo")).toBeInTheDocument();
});

test("detail ErrorBoundary renders 404 not found for a missing skill", () => {
  renderError(<DetailErrorBoundary />, new ApiError(404, "not found"));
  expect(screen.getByText(/404 not found/i)).toBeInTheDocument();
});
