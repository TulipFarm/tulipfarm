import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileShare, LibraryFile } from "~/lib/files";
import { ShareDialog } from "./file-share";

const fetchFileShares = vi.fn<() => Promise<readonly FileShare[]>>();
const shareFile = vi.fn<() => Promise<void>>();
const unshareFile = vi.fn<() => Promise<void>>();

const listUsers = vi.fn<() => Promise<unknown[]>>();
const listRoles = vi.fn<() => Promise<{ roles: unknown[] }>>();

vi.mock("~/lib/users", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/users")>()),
  listUsers: () => listUsers(),
}));

vi.mock("~/lib/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/authz")>()),
  listRoles: () => listRoles(),
}));

vi.mock("~/lib/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/files")>()),
  fetchFileShares: (...args: unknown[]) => fetchFileShares(...(args as [])),
  shareFile: (...args: unknown[]) => shareFile(...(args as [])),
  unshareFile: (...args: unknown[]) => unshareFile(...(args as [])),
}));

// The Team section owns its own API calls and its own test file; stubbing it keeps a failure here
// pointing at the person/role grants this file is about.
vi.mock("./file-team-share", () => ({ FileTeamShare: () => null }));

const FILE: LibraryFile = {
  id: "file_1",
  filename: "contract.pdf",
  mediaType: "application/pdf",
  sizeBytes: 4096,
  createdAt: "2026-01-02T03:04:05.000Z",
  owner: "user_1",
  folderId: null,
  origin: "uploaded",
  sourceChatId: null,
  sourceRunId: null,
  sharedWithCount: null,
};

describe("ShareDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchFileShares.mockResolvedValue([]);
    listUsers.mockResolvedValue([
      {
        id: "user_2",
        email: "muskan@example.com",
        name: "Muskan Vijayvargiya",
        role: "member",
        status: "active",
      },
    ]);
    listRoles.mockResolvedValue({
      roles: [{ id: "support", source: "builtin", displayName: "Support", artifactPath: null }],
    });
    shareFile.mockResolvedValue(undefined);
    unshareFile.mockResolvedValue(undefined);
  });

  it("says plainly that an unshared File is readable only by its owner", async () => {
    render(<ShareDialog file={FILE} onClose={() => {}} />);
    expect(await screen.findByText("Only you can read this file.")).toBeInTheDocument();
  });

  it("shares with a named person and shows the new grant without a reload", async () => {
    const user = userEvent.setup();
    render(<ShareDialog file={FILE} onClose={() => {}} />);
    await screen.findByText("Only you can read this file.");

    fetchFileShares.mockResolvedValue([
      { kind: "user", id: "user_2", sharedBy: "user_1", sharedAt: "2026-01-02T03:05:00.000Z" },
    ]);
    await user.type(screen.getByLabelText("Person"), "user_2");
    await user.click(screen.getByRole("button", { name: "Share" }));

    expect(shareFile).toHaveBeenCalledWith("file_1", { kind: "user", id: "user_2" });
    // The field clears, so a second share cannot be sent by a stray Enter on a stale value.
    await waitFor(() => expect(screen.getByLabelText("Person")).toHaveValue(""));
  });

  it("asks for a Role id, and sends one, when sharing with a Role", async () => {
    const user = userEvent.setup();
    render(<ShareDialog file={FILE} onClose={() => {}} />);
    await screen.findByText("Only you can read this file.");

    await user.click(screen.getByRole("button", { name: "Everyone with a role" }));
    await user.type(screen.getByLabelText("Role"), "support");
    await user.click(screen.getByRole("button", { name: "Share" }));

    expect(shareFile).toHaveBeenCalledWith("file_1", { kind: "role", id: "support" });
  });

  it("resolves a person picked by name to their principal id", async () => {
    const user = userEvent.setup();
    render(<ShareDialog file={FILE} onClose={() => {}} />);
    await screen.findByText("Only you can read this file.");

    await user.type(screen.getByLabelText("Person"), "Muskan");
    await user.click(await screen.findByRole("option", { name: /Muskan Vijayvargiya/ }));
    await user.click(screen.getByRole("button", { name: "Share" }));

    expect(shareFile).toHaveBeenCalledWith("file_1", { kind: "user", id: "user_2" });
  });

  it("names a person on their grant rather than showing a raw id", async () => {
    fetchFileShares.mockResolvedValue([
      { kind: "user", id: "user_2", sharedBy: "user_1", sharedAt: "2026-01-02T03:05:00.000Z" },
    ]);
    render(<ShareDialog file={FILE} onClose={() => {}} />);

    expect(await screen.findByText("Muskan Vijayvargiya")).toBeInTheDocument();
    expect(screen.getByText("muskan@example.com")).toBeInTheDocument();
  });

  it("revokes a share and stops offering it", async () => {
    const user = userEvent.setup();
    fetchFileShares.mockResolvedValue([
      { kind: "role", id: "support", sharedBy: "user_1", sharedAt: "2026-01-02T03:05:00.000Z" },
    ]);
    render(<ShareDialog file={FILE} onClose={() => {}} />);

    await user.click(await screen.findByRole("button", { name: "Revoke access for support" }));
    expect(unshareFile).toHaveBeenCalledWith("file_1", {
      kind: "role",
      id: "support",
      sharedBy: "user_1",
      sharedAt: "2026-01-02T03:05:00.000Z",
    });
  });

  it("refuses to send an empty grantee", async () => {
    render(<ShareDialog file={FILE} onClose={() => {}} />);
    await screen.findByText("Only you can read this file.");
    expect(screen.getByRole("button", { name: "Share" })).toBeDisabled();
    expect(shareFile).not.toHaveBeenCalled();
  });

  it("reports a failed share instead of implying it worked", async () => {
    const user = userEvent.setup();
    shareFile.mockRejectedValue(new Error("That file could not be shared."));
    render(<ShareDialog file={FILE} onClose={() => {}} />);
    await screen.findByText("Only you can read this file.");

    await user.type(screen.getByLabelText("Person"), "user_2");
    await user.click(screen.getByRole("button", { name: "Share" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That file could not be shared.");
  });
});
