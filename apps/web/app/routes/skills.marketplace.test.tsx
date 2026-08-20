import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";

// Mock the skills client so no real fetch/audit runs; drive the flow through the UI.
vi.mock("~/lib/skills", () => ({
  scanSkills: vi.fn(),
  auditSkill: vi.fn(),
  installSkills: vi.fn(),
  marketplaceSkills: vi.fn(),
  skillRowKey: (skill: { name: string; skillPath?: string }) => skill.skillPath ?? skill.name,
}));

import { auditSkill, installSkills, type MarketplaceCatalog, scanSkills } from "~/lib/skills";
import SkillsMarketplace from "./_app.skills.marketplace";

// Call arguments are asserted per test, so recorded calls must not leak between them.
beforeEach(() => {
  vi.clearAllMocks();
});

function renderInstall(catalog: MarketplaceCatalog | null = null) {
  const Stub = createRemixStub([
    { path: "/", Component: () => <SkillsMarketplace />, loader: () => ({ catalog }) },
  ]);
  render(<Stub initialEntries={["/"]} />);
}

test("scan → audit → advisory + operator confirm → install", async () => {
  const user = userEvent.setup();
  vi.mocked(scanSkills).mockResolvedValue({
    scanId: "s1",
    skills: [
      {
        name: "demo-skill",
        skillPath: "skills/demo-skill/SKILL.md",
        description: "A demo.",
        installed: false,
        updateAvailable: false,
      },
    ],
  });
  vi.mocked(auditSkill).mockResolvedValue({
    riskRating: "medium",
    summary: "Reads files.",
    toolsReach: ["filesystem"],
    findings: [{ severity: "warning", category: "credential-access", detail: "reads ~/.ssh" }],
    deterministicScan: {
      verdict: "dangerous",
      trustLevel: "community",
      findings: [
        {
          patternId: "invisible_unicode",
          severity: "critical",
          category: "injection",
          file: "SKILL.md",
          line: 4,
          match: "U+202E (RTL override)",
          description: "invisible unicode character RTL override",
        },
      ],
    },
  });
  vi.mocked(installSkills).mockResolvedValue({ installed: ["demo-skill"] });

  renderInstall();

  await user.type(await screen.findByLabelText(/git url/i), "owner/repo");
  await user.click(screen.getByRole("button", { name: /^Scan$/ }));

  // Discovered, but nothing installed yet and no confirm button until audited.
  expect(await screen.findByText("demo-skill")).toBeInTheDocument();
  expect(scanSkills).toHaveBeenCalledWith("owner/repo");
  expect(screen.queryByRole("button", { name: /confirm install/i })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /Run SkillAudit/ }));

  // Advisory framing is shown and install installs nothing until confirmed.
  expect(await screen.findByText(/advisory, not a guarantee/i)).toBeInTheDocument();
  expect(screen.getByText(/medium risk/i)).toBeInTheDocument();
  expect(screen.getByText(/reads ~\/.ssh/)).toBeInTheDocument();
  expect(screen.getByText("invisible_unicode")).toBeInTheDocument();
  expect(screen.getByText("U+202E (RTL override)")).toBeInTheDocument();
  expect(installSkills).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: /confirm install/i }));

  expect(await screen.findByText(/Installed demo-skill/i)).toBeInTheDocument();
  expect(installSkills).toHaveBeenCalledWith("s1", [
    { name: "demo-skill", skillPath: "skills/demo-skill/SKILL.md" },
  ]);
});

test("marketplace catalog feeds the same audit → operator-confirm flow", async () => {
  const user = userEvent.setup();
  vi.mocked(auditSkill).mockResolvedValue({
    riskRating: "low",
    summary: "Benign.",
    toolsReach: [],
    findings: [],
    deterministicScan: {
      verdict: "safe",
      trustLevel: "trusted",
      findings: [],
    },
  });
  vi.mocked(installSkills).mockResolvedValue({ installed: ["demo-skill"] });

  renderInstall({
    scanId: "mkt-1",
    source: "tulipfarm/skills",
    skills: [
      {
        name: "demo-skill",
        skillId: "demo-skill",
        description: "A demo.",
        installs: 42,
        installed: false,
        updateAvailable: false,
      },
    ],
  });

  // Catalog is shown with its install count; nothing is scanned yet.
  expect(await screen.findByText(/official marketplace/i)).toBeInTheDocument();
  expect(screen.getByText(/42 installs/i)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /confirm install/i })).not.toBeInTheDocument();

  // Reviewing loads the catalog into the normal select → audit → confirm pipeline.
  await user.click(screen.getByRole("button", { name: /review all/i }));
  await user.click(screen.getByRole("button", { name: /Run SkillAudit/ }));
  expect(await screen.findByText(/advisory, not a guarantee/i)).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /confirm install/i }));
  expect(await screen.findByText(/Installed demo-skill/i)).toBeInTheDocument();
  // A catalog row without a path falls back to identifying the skill by name.
  expect(installSkills).toHaveBeenCalledWith("mkt-1", [
    { name: "demo-skill", skillPath: undefined },
  ]);
});

test("a missing marketplace catalog still renders the manual git-url scan form", async () => {
  renderInstall(null);
  expect(await screen.findByLabelText(/git url/i)).toBeInTheDocument();
  expect(screen.queryByText(/official marketplace/i)).not.toBeInTheDocument();
});

test("catalog rows badge installed and update-available skills", async () => {
  renderInstall({
    scanId: "mkt-2",
    source: "tulipfarm/skills",
    skills: [
      {
        name: "fresh-skill",
        description: "Not yet installed.",
        category: "productivity",
        installed: false,
        updateAvailable: false,
      },
      {
        name: "current-skill",
        description: "Installed, current.",
        category: "productivity",
        installed: true,
        updateAvailable: false,
      },
      {
        name: "stale-skill",
        description: "Installed, stale.",
        category: "engineering",
        installed: true,
        updateAvailable: true,
      },
    ],
  });

  expect(await screen.findByText(/official marketplace/i)).toBeInTheDocument();
  // Current install reads as a badge; not-installed and stale get per-row actions.
  expect(screen.getByText(/installed ✓/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Install fresh-skill" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Update stale-skill" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "productivity" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "engineering" })).toBeInTheDocument();
  expect(screen.getByText("1 update available")).toBeInTheDocument();
});

test("per-row Install loads only that skill into the audit pipeline", async () => {
  const user = userEvent.setup();
  renderInstall({
    scanId: "mkt-3",
    source: "tulipfarm/skills",
    skills: [
      { name: "alpha-skill", description: "One.", installed: false, updateAvailable: false },
      { name: "beta-skill", description: "Two.", installed: false, updateAvailable: false },
    ],
  });

  const installButtons = await screen.findAllByRole("button", { name: /^Install /i });
  await user.click(installButtons[0]);
  // Only the chosen skill is queued for audit (1 selected), not the whole catalog.
  expect(await screen.findByRole("button", { name: /Run SkillAudit \(1\)/ })).toBeInTheDocument();
});

test("a scan failure surfaces an error banner", async () => {
  const user = userEvent.setup();
  vi.mocked(scanSkills).mockRejectedValue(
    new Error("scan failed: no SKILL.md files found in repo")
  );

  renderInstall();
  await user.type(await screen.findByLabelText(/git url/i), "owner/empty");
  await user.click(screen.getByRole("button", { name: /^Scan$/ }));

  expect(await screen.findByText(/scan failed: no SKILL\.md files found/i)).toBeInTheDocument();
});

// A source may define two different skills under the same directory name. Keying rows by name
// merged them into one selection, so the operator saw a checkbox they could not clear and the
// install request carried a different set of names from the one on screen.
test("two scanned skills sharing a name stay separately selectable", async () => {
  const user = userEvent.setup();
  vi.mocked(scanSkills).mockResolvedValue({
    scanId: "s2",
    skills: [
      {
        name: "review-contract",
        skillPath: "legal/review-contract/SKILL.md",
        description: "Legal review.",
        installed: false,
        updateAvailable: false,
      },
      {
        name: "review-contract",
        skillPath: "sales/review-contract/SKILL.md",
        description: "Sales review.",
        installed: false,
        updateAvailable: false,
      },
    ],
  });

  renderInstall();
  await user.type(await screen.findByLabelText(/git url/i), "owner/repo");
  await user.click(screen.getByRole("button", { name: /^Scan$/ }));

  const boxes = await screen.findAllByRole("checkbox");
  expect(boxes).toHaveLength(2);
  expect(screen.getByRole("button", { name: /Run SkillAudit \(2\)/ })).toBeInTheDocument();

  await user.click(boxes[0]);

  expect(boxes[0]).not.toBeChecked();
  expect(boxes[1]).toBeChecked();
  expect(screen.getByRole("button", { name: /Run SkillAudit \(1\)/ })).toBeInTheDocument();
});

test("an install failure is reported beside the confirm button, not only in the page banner", async () => {
  const user = userEvent.setup();
  vi.mocked(scanSkills).mockResolvedValue({
    scanId: "s3",
    skills: [
      {
        name: "demo-skill",
        skillPath: "skills/demo-skill/SKILL.md",
        description: "A demo.",
        installed: false,
        updateAvailable: false,
      },
    ],
  });
  vi.mocked(auditSkill).mockResolvedValue({
    riskRating: "low",
    summary: "Benign.",
    toolsReach: [],
    findings: [],
    deterministicScan: { verdict: "safe", trustLevel: "trusted", findings: [] },
  });
  vi.mocked(installSkills).mockRejectedValue(new Error("invalid soul write target"));

  renderInstall();
  await user.type(await screen.findByLabelText(/git url/i), "owner/repo");
  await user.click(screen.getByRole("button", { name: /^Scan$/ }));
  await user.click(await screen.findByRole("button", { name: /Run SkillAudit/ }));
  await user.click(await screen.findByRole("button", { name: /confirm install/i }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(/install failed: invalid soul write target/i);
  // The confirm button is still there to retry, and nothing claims a successful install.
  expect(screen.getByRole("button", { name: /confirm install/i })).toBeInTheDocument();
  expect(screen.queryByText(/^Installed /)).not.toBeInTheDocument();
});

// The two rows are distinct packages, so each must get its own report. Auditing by name alone
// makes the server resolve whichever row it listed first and shows that one report twice.
test("two scanned skills sharing a name are audited and reported separately", async () => {
  const user = userEvent.setup();
  vi.mocked(scanSkills).mockResolvedValue({
    scanId: "s4",
    skills: [
      {
        name: "review-contract",
        skillPath: "legal/review-contract/SKILL.md",
        description: "Negotiation playbook review.",
        installed: false,
        updateAvailable: false,
      },
      {
        name: "review-contract",
        skillPath: "small-business/review-contract/SKILL.md",
        description: "Plain-English review.",
        installed: false,
        updateAvailable: false,
      },
    ],
  });
  vi.mocked(auditSkill).mockImplementation(async (_scanId, _name, skillPath) => ({
    riskRating: "low",
    summary:
      skillPath === "legal/review-contract/SKILL.md" ? "Legal summary." : "Small-biz summary.",
    toolsReach: [],
    findings: [],
    deterministicScan: { verdict: "safe", trustLevel: "community", findings: [] },
  }));

  renderInstall();
  await user.type(await screen.findByLabelText(/git url/i), "owner/repo");
  await user.click(screen.getByRole("button", { name: /^Scan$/ }));
  await user.click(await screen.findByRole("button", { name: /Run SkillAudit \(2\)/ }));

  expect(await screen.findByText("Legal summary.")).toBeInTheDocument();
  expect(screen.getByText("Small-biz summary.")).toBeInTheDocument();
});

// What the operator selected must reach the install request intact. Sending bare names collapses
// the two rows into one string and silently drops a package the operator saw and confirmed.
test("the install payload identifies each selected row by its path", async () => {
  const user = userEvent.setup();
  vi.mocked(scanSkills).mockResolvedValue({
    scanId: "s5",
    skills: [
      {
        name: "review-contract",
        skillPath: "legal/review-contract/SKILL.md",
        description: "Negotiation playbook review.",
        installed: false,
        updateAvailable: false,
      },
      {
        name: "review-contract",
        skillPath: "small-business/review-contract/SKILL.md",
        description: "Plain-English review.",
        installed: false,
        updateAvailable: false,
      },
    ],
  });
  vi.mocked(auditSkill).mockResolvedValue({
    riskRating: "low",
    summary: "Benign.",
    toolsReach: [],
    findings: [],
    deterministicScan: { verdict: "safe", trustLevel: "community", findings: [] },
  });
  vi.mocked(installSkills).mockResolvedValue({ installed: ["review-contract"] });

  renderInstall();
  await user.type(await screen.findByLabelText(/git url/i), "owner/repo");
  await user.click(screen.getByRole("button", { name: /^Scan$/ }));
  await user.click(await screen.findByRole("button", { name: /Run SkillAudit \(2\)/ }));
  await user.click(await screen.findByRole("button", { name: /confirm install/i }));

  expect(installSkills).toHaveBeenCalledWith("s5", [
    { name: "review-contract", skillPath: "legal/review-contract/SKILL.md" },
    { name: "review-contract", skillPath: "small-business/review-contract/SKILL.md" },
  ]);
});

test("selecting one of two same-named rows installs exactly that row", async () => {
  const user = userEvent.setup();
  vi.mocked(scanSkills).mockResolvedValue({
    scanId: "s6",
    skills: [
      {
        name: "review-contract",
        skillPath: "legal/review-contract/SKILL.md",
        description: "Negotiation playbook review.",
        installed: false,
        updateAvailable: false,
      },
      {
        name: "review-contract",
        skillPath: "small-business/review-contract/SKILL.md",
        description: "Plain-English review.",
        installed: false,
        updateAvailable: false,
      },
    ],
  });
  vi.mocked(auditSkill).mockResolvedValue({
    riskRating: "low",
    summary: "Benign.",
    toolsReach: [],
    findings: [],
    deterministicScan: { verdict: "safe", trustLevel: "community", findings: [] },
  });
  vi.mocked(installSkills).mockResolvedValue({ installed: ["review-contract"] });

  renderInstall();
  await user.type(await screen.findByLabelText(/git url/i), "owner/repo");
  await user.click(screen.getByRole("button", { name: /^Scan$/ }));

  const boxes = await screen.findAllByRole("checkbox");
  await user.click(boxes[1]);
  await user.click(await screen.findByRole("button", { name: /Run SkillAudit \(1\)/ }));
  await user.click(await screen.findByRole("button", { name: /confirm install/i }));

  expect(installSkills).toHaveBeenCalledWith("s6", [
    { name: "review-contract", skillPath: "legal/review-contract/SKILL.md" },
  ]);
});

// #444: after the audit resolves the operator was offered two competing primary actions with no
// indication which one advanced the flow.
test("the audit action gives way to confirm once the selection is audited", async () => {
  const user = userEvent.setup();
  vi.mocked(scanSkills).mockResolvedValue({
    scanId: "s7",
    skills: [
      {
        name: "demo-skill",
        skillPath: "skills/demo-skill/SKILL.md",
        description: "A demo.",
        installed: false,
        updateAvailable: false,
      },
    ],
  });
  vi.mocked(auditSkill).mockResolvedValue({
    riskRating: "low",
    summary: "Benign.",
    toolsReach: [],
    findings: [],
    deterministicScan: { verdict: "safe", trustLevel: "trusted", findings: [] },
  });

  renderInstall();
  await user.type(await screen.findByLabelText(/git url/i), "owner/repo");
  await user.click(screen.getByRole("button", { name: /^Scan$/ }));
  await user.click(await screen.findByRole("button", { name: /Run SkillAudit/ }));

  expect(await screen.findByRole("button", { name: /confirm install/i })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Run SkillAudit/ })).not.toBeInTheDocument();

  // Changing the selection invalidates the audit, so the audit action comes back.
  await user.click(screen.getByRole("checkbox"));
  expect(await screen.findByRole("button", { name: /Run SkillAudit \(0\)/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /confirm install/i })).not.toBeInTheDocument();
});

// #444: the report list is long, so an error rendered in place is still off-screen. Move focus to
// it so the failure is announced and scrolled to at the point of failure.
test("an install failure takes focus so it is seen at the point of failure", async () => {
  const user = userEvent.setup();
  vi.mocked(scanSkills).mockResolvedValue({
    scanId: "s8",
    skills: [
      {
        name: "demo-skill",
        skillPath: "skills/demo-skill/SKILL.md",
        description: "A demo.",
        installed: false,
        updateAvailable: false,
      },
    ],
  });
  vi.mocked(auditSkill).mockResolvedValue({
    riskRating: "low",
    summary: "Benign.",
    toolsReach: [],
    findings: [],
    deterministicScan: { verdict: "safe", trustLevel: "trusted", findings: [] },
  });
  vi.mocked(installSkills).mockRejectedValue(new Error("invalid soul write target"));

  renderInstall();
  await user.type(await screen.findByLabelText(/git url/i), "owner/repo");
  await user.click(screen.getByRole("button", { name: /^Scan$/ }));
  await user.click(await screen.findByRole("button", { name: /Run SkillAudit/ }));
  await user.click(await screen.findByRole("button", { name: /confirm install/i }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(/install failed: invalid soul write target/i);
  expect(alert).toHaveFocus();
});

// #447: the catalog is ~88 rows deep and every row ships the same action, so the accessible name
// is the only thing a reader navigating by role has to tell them apart. "Install" repeated is a
// list of identical controls: it names the verb and never the Skill the verb applies to.
test("each catalog row's action is named for the skill it acts on", async () => {
  renderInstall({
    scanId: "mkt-4",
    source: "tulipfarm/skills",
    skills: [
      { name: "kb-article", description: "One.", installed: false, updateAvailable: false },
      { name: "sql-queries", description: "Two.", installed: false, updateAvailable: false },
      { name: "ticket-triage", description: "Three.", installed: true, updateAvailable: true },
    ],
  });

  const actions = await screen.findAllByRole("button", { name: /^(install|update) /i });
  expect(actions).toHaveLength(3);
  // Pairwise distinct: each name resolves to exactly one control.
  for (const name of ["Install kb-article", "Install sql-queries", "Update ticket-triage"]) {
    expect(screen.getAllByRole("button", { name }), name).toHaveLength(1);
  }
});
