import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";
import type { SkillDetail as SkillDetailData, SkillSummary } from "~/lib/skills";

vi.mock("~/lib/skills", async (orig) => {
  const actual = await orig<typeof import("~/lib/skills")>();
  return { ...actual, removeSkill: vi.fn(), getSkillFile: vi.fn() };
});

import { getSkillFile, removeSkill } from "~/lib/skills";
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

beforeEach(() => {
  vi.clearAllMocks();
});

function renderError(node: ReactElement, error: unknown) {
  vi.mocked(remix.useRouteError).mockReturnValue(error);
  render(node);
}

const SKILLS: SkillSummary[] = [
  {
    name: "demo-skill",
    description: "A demo.",
    provenance: "marketplace",
    source: "owner/repo",
    category: "forge",
    author: "Muskan Vijayvargiya",
    updatedAt: "2026-09-04T12:00:00.000Z",
    tools: ["record_search", "present"],
  },
  {
    name: "my-skill",
    description: "Mine.",
    provenance: "curated",
    category: "core",
    allowedDomains: ["example.com"],
  },
];

const AGENTS = [
  {
    name: "reviewer",
    label: "Review agent",
    capabilityRestrictions: { skills: { allow: ["demo-skill"] } },
  },
];

function detail(overrides: Partial<SkillDetailData> = {}): { skill: SkillDetailData; agents: [] } {
  return {
    skill: {
      name: "demo-skill",
      description: "A demo.",
      provenance: "marketplace",
      source: "owner/repo",
      body: "# Demo\nDoes the demo.",
      files: [],
      commands: [],
      ...overrides,
    },
    agents: [],
  };
}

test("index shows starter packs and links each installed skill to its detail page", () => {
  renderWithData(<SkillsIndex />, { skills: SKILLS, agents: AGENTS });

  expect(screen.getByRole("link", { name: /demo-skill/ })).toHaveAttribute(
    "href",
    "/skills/demo-skill"
  );
  expect(screen.getByRole("heading", { name: "Starter packs" })).toBeInTheDocument();
  expect(screen.getByText("Product design kit")).toBeInTheDocument();
  expect(screen.getByText("Frontend engineer")).toBeInTheDocument();
  expect(screen.getByText("Backend and infra")).toBeInTheDocument();
  expect(screen.getAllByText("Coming soon")).toHaveLength(4);
  expect(screen.getByRole("link", { name: /browse marketplace/i })).toHaveAttribute(
    "href",
    "/skills/marketplace"
  );
});

test("index shows useful installed-skill columns and searches across them", async () => {
  const user = userEvent.setup();
  renderWithData(<SkillsIndex />, { skills: SKILLS, agents: AGENTS });

  expect(screen.getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "Description" })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "Type" })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "Agents" })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "Author" })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "Updated" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Review agent" })).toHaveAttribute(
    "href",
    "/agents/reviewer"
  );
  expect(screen.getByText("Muskan Vijayvargiya")).toBeInTheDocument();

  await user.type(screen.getByLabelText("Search installed skills"), "review agent");
  expect(screen.getByRole("link", { name: /demo-skill/ })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /my-skill/ })).not.toBeInTheDocument();
});

test("index search matches the skill type", async () => {
  const user = userEvent.setup();
  renderWithData(<SkillsIndex />, { skills: SKILLS, agents: AGENTS });

  await user.type(screen.getByLabelText("Search installed skills"), "forge");
  expect(screen.getByRole("link", { name: /demo-skill/ })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /my-skill/ })).not.toBeInTheDocument();
});

test("index with no skills keeps the starter previews and shows an empty installed section", () => {
  renderWithData(<SkillsIndex />, { skills: [], agents: [] });
  expect(screen.getByText(/no skills installed yet/i)).toBeInTheDocument();
  expect(screen.getAllByRole("link", { name: /browse marketplace/i })).toHaveLength(1);
  expect(screen.getByText("Product design kit")).toBeInTheDocument();
});

test("detail renders the SKILL.md body and its provenance facts", () => {
  renderWithData(<SkillDetail />, detail({ category: "forge", version: "1.2.0" }));

  expect(screen.getByText("Does the demo.")).toBeInTheDocument();
  expect(screen.getByText("owner/repo")).toBeInTheDocument();
  expect(screen.getByText("forge")).toBeInTheDocument();
  expect(screen.getByText("1.2.0")).toBeInTheDocument();
});

test("detail names the tools, hosts and secrets the skill declares", () => {
  renderWithData(
    <SkillDetail />,
    detail({
      tools: ["web_fetch"],
      allowedDomains: ["raw.githubusercontent.com"],
      requiredSecrets: ["GITHUB_TOKEN"],
    })
  );

  expect(screen.getByText("web_fetch")).toBeInTheDocument();
  expect(screen.getByText("raw.githubusercontent.com")).toBeInTheDocument();
  expect(screen.getByText("GITHUB_TOKEN")).toBeInTheDocument();
  // Leasing a credential is the top of the reach scale, so it must be what the header reports.
  expect(screen.getAllByText("Needs secrets").length).toBeGreaterThan(0);
});

test("detail says plainly when a skill reaches nothing", () => {
  renderWithData(<SkillDetail />, detail());

  expect(screen.getByText("Instructions only")).toBeInTheDocument();
  expect(
    screen.getByText(/cannot run code, open a connection, or read a secret/i)
  ).toBeInTheDocument();
  expect(screen.getByText(/it is instructions the agent reads/i)).toBeInTheDocument();
});

test("detail shows a runnable command and why a blocked one cannot run", () => {
  renderWithData(
    <SkillDetail />,
    detail({
      name: "reporting",
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
    })
  );

  expect(screen.getByText("generate")).toBeInTheDocument();
  expect(screen.getByText("Cannot run")).toBeInTheDocument();
  expect(screen.getByText(/python3, gws/)).toBeInTheDocument();
  expect(
    screen.getByText("runtime_requirement_unavailable:shell-ts-python-v1:gws")
  ).toBeInTheDocument();
});

test("detail groups package files by what each one is for", () => {
  renderWithData(
    <SkillDetail />,
    detail({
      files: [
        { path: "SKILL.md", size: 2048 },
        { path: "references/authoring.md", size: 4601 },
        { path: "scripts/report.py", size: 120 },
      ],
    })
  );

  expect(screen.getByRole("heading", { name: /Manifest/ })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: /References/ })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: /Scripts/ })).toBeInTheDocument();
  // Sizes read as sizes, not as a raw byte count nobody can scale.
  expect(screen.getByText("4.5 KB")).toBeInTheDocument();
});

test("detail opens a reference file and shows its contents", async () => {
  const user = userEvent.setup();
  vi.mocked(getSkillFile).mockResolvedValue({
    path: "references/authoring.md",
    size: 34,
    content: "# Authoring\nStart from the template.",
    truncated: false,
  });
  renderWithData(
    <SkillDetail />,
    detail({ files: [{ path: "references/authoring.md", size: 34 }] })
  );

  const toggle = screen.getByRole("button", { name: /references\/authoring\.md/ });
  expect(toggle).toHaveAttribute("aria-expanded", "false");

  await user.click(toggle);
  expect(getSkillFile).toHaveBeenCalledWith("demo-skill", "references/authoring.md");
  expect(await screen.findByText("Start from the template.")).toBeInTheDocument();
  expect(toggle).toHaveAttribute("aria-expanded", "true");
});

test("detail reports which agents can load the skill", () => {
  vi.mocked(remix.useLoaderData).mockReturnValue({
    ...detail(),
    agents: [
      { name: "pinner", capabilityRestrictions: { skills: { allow: ["demo-skill"] } } },
      { name: "blocker", capabilityRestrictions: { skills: { deny: ["demo-skill"] } } },
      { name: "open-agent" },
    ],
  });
  const Stub = createRemixStub([{ path: "/", Component: () => <SkillDetail /> }]);
  render(<Stub initialEntries={["/"]} />);

  const panel = screen.getByRole("region", { name: /who can use it/i });
  expect(within(panel).getByText("Named by 1 agent")).toBeInTheDocument();
  expect(within(panel).getByText("Available to 1 more agent")).toBeInTheDocument();
  expect(within(panel).getByText("Blocked for 1 agent")).toBeInTheDocument();
  expect(within(panel).getByRole("link", { name: "pinner" })).toHaveAttribute(
    "href",
    "/agents/pinner"
  );
});

test("detail Remove requires a second confirming click before deleting", async () => {
  const user = userEvent.setup();
  vi.mocked(removeSkill).mockResolvedValue(undefined);
  renderWithData(<SkillDetail />, detail());

  await user.click(screen.getByRole("button", { name: /^remove$/i }));
  // First click only arms the confirm — nothing deleted yet.
  expect(removeSkill).not.toHaveBeenCalled();
  expect(screen.getByText(/records the change in the soul history/i)).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /confirm remove/i }));
  expect(removeSkill).toHaveBeenCalledWith("demo-skill");
});

test("detail arming Remove can be cancelled without deleting", async () => {
  const user = userEvent.setup();
  vi.mocked(removeSkill).mockResolvedValue(undefined);
  renderWithData(<SkillDetail />, detail());

  await user.click(screen.getByRole("button", { name: /^remove$/i }));
  await user.click(screen.getByRole("button", { name: /^cancel$/i }));

  expect(removeSkill).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: /^remove$/i })).toBeInTheDocument();
});

test("detail ErrorBoundary renders 404 not found for a missing skill", () => {
  renderError(<DetailErrorBoundary />, new ApiError(404, "not found"));
  expect(screen.getByText(/404 not found/i)).toBeInTheDocument();
});
