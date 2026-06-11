import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

// Mock the skills client so no real fetch/audit runs; drive the flow through the UI.
vi.mock("~/lib/skills", () => ({
  scanSkills: vi.fn(),
  auditSkill: vi.fn(),
  installSkills: vi.fn(),
  marketplaceSkills: vi.fn(),
}));

import { auditSkill, installSkills, type MarketplaceCatalog, scanSkills } from "~/lib/skills";
import SkillsMarketplace from "./_app.skills.marketplace";

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
      { name: "demo-skill", description: "A demo.", installed: false, updateAvailable: false },
    ],
  });
  vi.mocked(auditSkill).mockResolvedValue({
    riskRating: "medium",
    summary: "Reads files.",
    toolsReach: ["filesystem"],
    findings: [{ severity: "warning", category: "credential-access", detail: "reads ~/.ssh" }],
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

  // Advisory framing is shown (AC-V1-004) and install installs nothing until confirmed.
  expect(await screen.findByText(/advisory, not a guarantee/i)).toBeInTheDocument();
  expect(screen.getByText(/medium risk/i)).toBeInTheDocument();
  expect(screen.getByText(/reads ~\/.ssh/)).toBeInTheDocument();
  expect(installSkills).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: /confirm install/i }));

  expect(await screen.findByText(/Installed demo-skill/i)).toBeInTheDocument();
  expect(installSkills).toHaveBeenCalledWith("s1", ["demo-skill"]);
});

test("marketplace catalog feeds the same audit → operator-confirm flow", async () => {
  const user = userEvent.setup();
  vi.mocked(auditSkill).mockResolvedValue({
    riskRating: "low",
    summary: "Benign.",
    toolsReach: [],
    findings: [],
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
  expect(installSkills).toHaveBeenCalledWith("mkt-1", ["demo-skill"]);
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
        installed: false,
        updateAvailable: false,
      },
      {
        name: "current-skill",
        description: "Installed, current.",
        installed: true,
        updateAvailable: false,
      },
      {
        name: "stale-skill",
        description: "Installed, stale.",
        installed: true,
        updateAvailable: true,
      },
    ],
  });

  expect(await screen.findByText(/official marketplace/i)).toBeInTheDocument();
  // Current install reads as a badge; not-installed and stale get per-row actions.
  expect(screen.getByText(/installed ✓/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^Install$/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^Update$/ })).toBeInTheDocument();
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

  const installButtons = await screen.findAllByRole("button", { name: /^Install$/ });
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
