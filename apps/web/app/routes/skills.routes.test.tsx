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

test("index counts skills, offers the tabs, and links each row to its detail page", () => {
  renderWithData(<SkillsIndex />, { skills: SKILLS });

  expect(screen.getByText("skills").previousElementSibling).toHaveTextContent("2");
  expect(screen.getByRole("link", { name: /demo-skill/ })).toHaveAttribute(
    "href",
    "/skills/demo-skill"
  );
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

test("index names what each skill reaches, so a scan answers it without opening a row", () => {
  renderWithData(<SkillsIndex />, { skills: SKILLS });

  // Scoped to each row: the reach filter lists the same words as its options.
  const demo = screen.getByRole("link", { name: /demo-skill/ });
  expect(within(demo).getByText("Instructions only")).toBeInTheDocument();
  expect(within(demo).getByText(/2 tools · record_search, present/)).toBeInTheDocument();

  const mine = screen.getByRole("link", { name: /my-skill/ });
  expect(within(mine).getByText("Reaches network")).toBeInTheDocument();
  expect(within(mine).getByText("1 host")).toBeInTheDocument();
});

test("index groups by the author's category and can filter down to one", async () => {
  const user = userEvent.setup();
  renderWithData(<SkillsIndex />, { skills: SKILLS });

  expect(screen.getByRole("heading", { name: /forge/i, level: 2 })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: /core/i, level: 2 })).toBeInTheDocument();

  await user.selectOptions(screen.getByLabelText("Category"), "forge");
  expect(screen.getByText("1 of 2 skills match")).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /my-skill/ })).not.toBeInTheDocument();
});

test("index search matches a tool name, not just the description", async () => {
  const user = userEvent.setup();
  renderWithData(<SkillsIndex />, { skills: SKILLS });

  await user.type(screen.getByLabelText("Search skills"), "record_search");
  expect(screen.getByRole("link", { name: /demo-skill/ })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /my-skill/ })).not.toBeInTheDocument();
});

test("index distinguishes a Skill from an Agent and links to Agents", () => {
  renderWithData(<SkillsIndex />, { skills: [] });
  expect(screen.getByText(/a procedure an/i)).toBeInTheDocument();
  expect(screen.getByText(/grants no permissions of its own/i)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "agent" })).toHaveAttribute("href", "/agents");
});

test("index with no skills explains what a skill is for and offers the marketplace", () => {
  renderWithData(<SkillsIndex />, { skills: [] });
  expect(screen.getByText(/no skills installed yet/i)).toBeInTheDocument();
  // One route to the marketplace, in the header. The empty state offers the other way to get a
  // skill instead of repeating it.
  expect(screen.getAllByRole("link", { name: /browse marketplace/i })).toHaveLength(1);
  expect(screen.getByRole("link", { name: /ask an agent to write one/i })).toHaveAttribute(
    "href",
    "/?agent=skill-forge"
  );
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
