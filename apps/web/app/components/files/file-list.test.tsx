import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import type { LibraryFile } from "~/lib/files";
import { FileList } from "./file-list";

vi.mock("~/lib/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/files")>()),
  fetchFileObjectUrl: vi.fn(),
}));

function libraryFile(overrides: Partial<LibraryFile> = {}): LibraryFile {
  return {
    id: "file_1",
    filename: "report.pdf",
    mediaType: "application/pdf",
    sizeBytes: 2048,
    createdAt: "2026-01-02T03:04:05.000Z",
    modifiedAt: "2026-02-03T04:05:06.000Z",
    revision: 2,
    currentVersionId: "version_2",
    archivedAt: null,
    owner: "user_1",
    ownerName: "Muskan Vijayvargiya",
    folderId: null,
    origin: "uploaded",
    sourceChatId: null,
    sourceRunId: null,
    sharedWithCount: 0,
    inKnowledge: false,
    ...overrides,
  };
}

function renderList(
  files: readonly LibraryFile[],
  actions: Partial<ComponentProps<typeof FileList>> = {}
) {
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => (
        <FileList files={files} viewerId="user_1" onPreview={() => {}} {...actions} />
      ),
    },
  ]);
  return render(<Stub initialEntries={["/"]} />);
}

describe("FileList", () => {
  it("renders the required dense semantic table columns", () => {
    renderList([libraryFile()]);

    expect(screen.getByRole("table")).toBeInTheDocument();
    for (const name of ["Name", "Owner", "Access", "Modified", "Size"]) {
      expect(screen.getByRole("columnheader", { name })).toBeInTheDocument();
    }
  });

  it("opens preview from the filename or row without an eye action", async () => {
    const user = userEvent.setup();
    const onPreview = vi.fn();
    renderList([libraryFile()], { onPreview });

    await user.click(screen.getByRole("button", { name: "Preview report.pdf" }));
    expect(onPreview).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Owner: Muskan Vijayvargiya" }));
    expect(onPreview).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByRole("button", { name: "Preview report.pdf", hidden: false })
    ).toBeTruthy();
  });

  it("shows owners as avatars with popup labels and access as badges", async () => {
    const user = userEvent.setup();
    renderList([
      libraryFile({
        id: "private",
        filename: "private.pdf",
        ownerName: "admin@tulipfarm.dev",
      }),
      libraryFile({
        id: "shared",
        filename: "shared.pdf",
        ownerName: "admin@tulipfarm.dev",
        sharedWithCount: 3,
      }),
      libraryFile({
        id: "theirs",
        filename: "theirs.pdf",
        owner: "user_2",
        ownerName: "Other Person",
      }),
    ]);

    expect(screen.queryByText("admin@tulipfarm.dev")).toBeNull();
    const owner = screen.getAllByRole("button", { name: "Owner: admin@tulipfarm.dev" })[0];
    if (!owner) throw new Error("Expected an owner avatar");
    await user.hover(owner);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("admin@tulipfarm.dev");
    for (const label of ["Private", "Shared with 3", "Shared with you"]) {
      expect(screen.getByText(label)).toHaveClass("rounded-full", "border");
    }
  });

  it("groups secondary actions into one accessible menu", async () => {
    const user = userEvent.setup();
    const onAttach = vi.fn();
    const onShare = vi.fn();
    const onArchive = vi.fn();
    renderList([libraryFile()], { onAttach, onShare, onArchive });

    expect(screen.queryByRole("button", { name: "Share report.pdf" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Actions for report.pdf" }));
    expect(screen.getByRole("menuitem", { name: "Share" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Archive" }));

    expect(onArchive).toHaveBeenCalledWith(expect.objectContaining({ id: "file_1" }));
  });

  it("offers permanent delete only for an archived File the viewer owns", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    renderList([libraryFile({ archivedAt: "2026-03-01T00:00:00.000Z" })], { onDelete });

    await user.click(screen.getByRole("button", { name: "Actions for report.pdf" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete permanently" }));

    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: "file_1" }));
  });

  it("does not offer owner actions on a File shared with the viewer", async () => {
    const user = userEvent.setup();
    renderList([libraryFile({ owner: "user_2" })], {
      onShare: vi.fn(),
      onArchive: vi.fn(),
      onDelete: vi.fn(),
    });

    await user.click(screen.getByRole("button", { name: "Actions for report.pdf" }));
    expect(screen.queryByRole("menuitem", { name: "Share" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Archive" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Delete permanently" })).toBeNull();
  });
});

describe("a download that fails", () => {
  it("announces the failure", async () => {
    const files = await import("~/lib/files");
    vi.mocked(files.fetchFileObjectUrl).mockRejectedValueOnce(new Error("gone"));
    renderList([libraryFile()]);

    await userEvent.click(screen.getByRole("button", { name: "Actions for report.pdf" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Download" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Download failed");
  });
});
