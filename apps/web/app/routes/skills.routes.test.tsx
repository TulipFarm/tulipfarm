import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";

vi.mock("~/lib/skills", async (orig) => {
  const actual = await orig<typeof import("~/lib/skills")>();
  return { ...actual, removeSkill: vi.fn() };
});

import { removeSkill } from "~/lib/skills";
import SkillsIndex from "./_app.skills._index";
import SkillDetail, { ErrorBoundary as DetailErrorBoundary } from "./_app.skills.$name";

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

test("index lists skills with provenance, tab nav, and a marketplace entry", () => {
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
  // Tab nav to both panes.
  expect(screen.getByRole("link", { name: /^Installed$/ })).toHaveAttribute("href", "/skills");
  expect(screen.getByRole("link", { name: /^Marketplace$/ })).toHaveAttribute(
    "href",
    "/skills/marketplace"
  );
  expect(screen.getByRole("link", { name: /browse marketplace/i })).toHaveAttribute(
    "href",
    "/skills/marketplace"
  );
});

test("index with no skills shows the empty message and a marketplace entry", () => {
  renderWithData(<SkillsIndex />, { skills: [] });
  expect(screen.getByText("0 skills")).toBeInTheDocument();
  expect(screen.getByText(/no skills installed yet/i)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /browse marketplace/i })).toHaveAttribute(
    "href",
    "/skills/marketplace"
  );
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

test("detail shows executable Tools, runtime blockers, and package files", () => {
  renderWithData(<SkillDetail />, {
    skill: {
      name: "reporting",
      provenance: "marketplace",
      body: "# Reporting",
      commands: [
        {
          name: "generate",
          toolRef: "report.generate",
          runtimeProfile: "shell-ts-python-v1",
          entrypoint: "scripts/report.py",
          requiredCommands: ["python3", "gws"],
          runtimeAvailable: false,
          blocker: "runtime_requirement_unavailable:shell-ts-python-v1:gws",
        },
      ],
      files: [{ path: "scripts/report.py", size: 120 }],
    },
  });

  expect(screen.getByText("Executable Tools")).toBeInTheDocument();
  expect(screen.getByText("publication blocked")).toBeInTheDocument();
  expect(screen.getByText(/python3, gws/)).toBeInTheDocument();
  expect(screen.getByText("scripts/report.py")).toBeInTheDocument();
});

test("detail Remove requires a second confirming click before deleting", async () => {
  const user = userEvent.setup();
  vi.mocked(removeSkill).mockResolvedValue(undefined);
  renderWithData(<SkillDetail />, {
    skill: {
      name: "demo-skill",
      provenance: "marketplace",
      source: "owner/repo",
      body: "# Demo",
    },
  });

  await user.click(screen.getByRole("button", { name: /^remove$/i }));
  // First click only arms the confirm — nothing deleted yet.
  expect(removeSkill).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: /confirm remove/i }));
  expect(removeSkill).toHaveBeenCalledWith("demo-skill");
});

test("detail ErrorBoundary renders 404 not found for a missing skill", () => {
  renderError(<DetailErrorBoundary />, new ApiError(404, "not found"));
  expect(screen.getByText(/404 not found/i)).toBeInTheDocument();
});
