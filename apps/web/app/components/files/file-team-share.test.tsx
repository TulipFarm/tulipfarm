import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamAssetOwnership, TeamDirectoryEntry } from "~/lib/teams";
import { FileTeamShare } from "./file-team-share";

const getTeamAssetAccess = vi.fn();
const listTeams = vi.fn();
const updateTeamAssetShares = vi.fn();
const proposeTeamAssetOperation = vi.fn();

vi.mock("~/lib/teams", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/teams")>()),
  getTeamAssetAccess: (...args: unknown[]) => getTeamAssetAccess(...args),
  listTeams: (...args: unknown[]) => listTeams(...args),
  updateTeamAssetShares: (...args: unknown[]) => updateTeamAssetShares(...args),
  proposeTeamAssetOperation: (...args: unknown[]) => proposeTeamAssetOperation(...args),
}));

function team(id: string, displayName: string): TeamDirectoryEntry {
  return {
    id,
    businessId: "business",
    slug: id,
    displayName,
    description: null,
    status: "active",
    parentTeamId: null,
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    members: [],
  };
}

function projection(ownership: Partial<TeamAssetOwnership>, canManageOwnership = true) {
  return {
    ownership: { owners: [], shares: [], revision: 3, ...ownership },
    access: { levels: ["view", "use", "edit"], canManageOwnership, evidence: [] },
  };
}

describe("FileTeamShare", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listTeams.mockResolvedValue({
      teams: [team("team-support", "Support"), team("team-billing", "Billing")],
    });
    getTeamAssetAccess.mockResolvedValue(projection({}));
    updateTeamAssetShares.mockResolvedValue(undefined);
    proposeTeamAssetOperation.mockResolvedValue(undefined);
  });

  it("says plainly that no Team can reach a personally owned File", async () => {
    render(<FileTeamShare fileId="file_1" />);
    expect(await screen.findByText("No Team can reach this file.")).toBeInTheDocument();
    expect(screen.getByText("Nobody but the uploader")).toBeInTheDocument();
  });

  it("names the owning Team rather than its id", async () => {
    getTeamAssetAccess.mockResolvedValue(
      projection({ owners: [{ kind: "team", teamId: "team-support" }] })
    );
    render(<FileTeamShare fileId="file_1" />);
    expect(await screen.findByText("Support")).toBeInTheDocument();
  });

  it("shares with a Team at the chosen level, against the revision it read", async () => {
    const user = userEvent.setup();
    render(<FileTeamShare fileId="file_1" />);
    await screen.findByText("No Team can reach this file.");

    await user.type(screen.getByLabelText("Team"), "Support — team-support");
    await user.click(screen.getByRole("button", { name: "Share with Team" }));

    await waitFor(() =>
      expect(updateTeamAssetShares).toHaveBeenCalledWith(
        "file",
        "file_1",
        [{ teamId: "team-support", access: "view" }],
        3
      )
    );
  });

  it("shares at a level the reader picked, not the default", async () => {
    const user = userEvent.setup();
    render(<FileTeamShare fileId="file_1" />);
    await screen.findByText("No Team can reach this file.");

    await user.type(screen.getByLabelText("Team"), "Support — team-support");
    // Typed, not clicked: clicking an option commits through onCommit either way, so only typing
    // proves the field accepts input at all.
    await user.click(screen.getByLabelText("They can"));
    await user.keyboard("Edit{Enter}");
    await user.click(screen.getByRole("button", { name: "Share with Team" }));

    await waitFor(() =>
      expect(updateTeamAssetShares).toHaveBeenCalledWith(
        "file",
        "file_1",
        [{ teamId: "team-support", access: "edit" }],
        3
      )
    );
  });

  it("revokes one Team without disturbing the others", async () => {
    const user = userEvent.setup();
    getTeamAssetAccess.mockResolvedValue(
      projection({
        shares: [
          { teamId: "team-support", access: "view" },
          { teamId: "team-billing", access: "edit" },
        ],
      })
    );
    render(<FileTeamShare fileId="file_1" />);

    await user.click(await screen.findByRole("button", { name: "Revoke access for Support" }));

    await waitFor(() =>
      expect(updateTeamAssetShares).toHaveBeenCalledWith(
        "file",
        "file_1",
        [{ teamId: "team-billing", access: "edit" }],
        3
      )
    );
  });

  it("offers no controls to someone who may only read the File", async () => {
    getTeamAssetAccess.mockResolvedValue(
      projection({ shares: [{ teamId: "team-support", access: "view" }] }, false)
    );
    render(<FileTeamShare fileId="file_1" />);

    expect(await screen.findByText("Support")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Share with Team" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Revoke access for Support" })
    ).not.toBeInTheDocument();
  });

  it("asks for an Approval rather than silently transferring ownership", async () => {
    const user = userEvent.setup();
    render(<FileTeamShare fileId="file_1" />);
    await screen.findByText("No Team can reach this file.");

    await user.type(screen.getByLabelText("Team"), "Billing — team-billing");
    await user.click(screen.getByRole("button", { name: "Make owner" }));

    await waitFor(() =>
      expect(proposeTeamAssetOperation).toHaveBeenCalledWith("file", "file_1", {
        action: "add_owner",
        teamId: "team-billing",
        revision: 3,
      })
    );
  });

  it("reports a failed share instead of implying it worked", async () => {
    const user = userEvent.setup();
    updateTeamAssetShares.mockRejectedValue(new Error("Sharing is locked."));
    render(<FileTeamShare fileId="file_1" />);
    await screen.findByText("No Team can reach this file.");

    await user.type(screen.getByLabelText("Team"), "Support — team-support");
    await user.click(screen.getByRole("button", { name: "Share with Team" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Sharing is locked.");
  });
});
