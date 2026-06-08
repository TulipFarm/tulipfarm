import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

// Mock the skills client so no real fetch/audit runs; drive the flow through the UI.
vi.mock("~/lib/skills", () => ({
  scanSkills: vi.fn(),
  auditSkill: vi.fn(),
  installSkills: vi.fn(),
}));

import { auditSkill, installSkills, scanSkills } from "~/lib/skills";
import SkillInstall from "./_app.skills.install";

function renderInstall() {
  const Stub = createRemixStub([{ path: "/", Component: () => <SkillInstall /> }]);
  render(<Stub initialEntries={["/"]} />);
}

test("scan → audit → advisory + operator confirm → install", async () => {
  const user = userEvent.setup();
  vi.mocked(scanSkills).mockResolvedValue({
    scanId: "s1",
    skills: [{ name: "demo-skill", description: "A demo." }],
  });
  vi.mocked(auditSkill).mockResolvedValue({
    riskRating: "medium",
    summary: "Reads files.",
    toolsReach: ["filesystem"],
    findings: [{ severity: "warning", category: "credential-access", detail: "reads ~/.ssh" }],
  });
  vi.mocked(installSkills).mockResolvedValue({ installed: ["demo-skill"] });

  renderInstall();

  await user.type(screen.getByLabelText(/git url/i), "owner/repo");
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

test("a scan failure surfaces an error banner", async () => {
  const user = userEvent.setup();
  vi.mocked(scanSkills).mockRejectedValue(
    new Error("scan failed: no SKILL.md files found in repo")
  );

  renderInstall();
  await user.type(screen.getByLabelText(/git url/i), "owner/empty");
  await user.click(screen.getByRole("button", { name: /^Scan$/ }));

  expect(await screen.findByText(/scan failed: no SKILL\.md files found/i)).toBeInTheDocument();
});
