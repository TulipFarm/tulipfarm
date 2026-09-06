import { createRemixStub } from "@remix-run/testing";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileTypeIcon, fileTypeIconName, fileTypeLabel } from "~/components/files/file-type-icon";
import type { FileFolder, FilePage, LibraryFile } from "~/lib/files";
import FilesIndex from "./_app.files";

const fetchFiles = vi.fn<() => Promise<FilePage>>();
const fetchSharedWithMe = vi.fn<() => Promise<FilePage>>();
const fetchArchivedFiles = vi.fn<() => Promise<FilePage>>();
const searchFiles = vi.fn<() => Promise<readonly LibraryFile[]>>();
const archiveFile = vi.fn();
const restoreArchivedFile = vi.fn();
const deleteFile = vi.fn();
const uploadFile = vi.fn();
const shareFile = vi.fn();
const fetchFileFolders = vi.fn<() => Promise<readonly FileFolder[]>>();
const createFileFolder = vi.fn();
const moveFile = vi.fn();
const renameFileFolder = vi.fn();
const deleteFileFolder = vi.fn();

vi.mock("~/lib/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/files")>()),
  fetchFiles: (...args: unknown[]) => fetchFiles(...(args as [])),
  fetchSharedWithMe: (...args: unknown[]) => fetchSharedWithMe(...(args as [])),
  fetchArchivedFiles: (...args: unknown[]) => fetchArchivedFiles(...(args as [])),
  searchFiles: (...args: unknown[]) => searchFiles(...(args as [])),
  fetchFileObjectUrl: vi.fn(),
  archiveFile: (...args: unknown[]) => archiveFile(...args),
  restoreArchivedFile: (...args: unknown[]) => restoreArchivedFile(...args),
  deleteFile: (...args: unknown[]) => deleteFile(...args),
  uploadFile: (...args: unknown[]) => uploadFile(...args),
  shareFile: (...args: unknown[]) => shareFile(...args),
  fetchFileFolders: (...args: unknown[]) => fetchFileFolders(...(args as [])),
  createFileFolder: (...args: unknown[]) => createFileFolder(...args),
  moveFile: (...args: unknown[]) => moveFile(...args),
  renameFileFolder: (...args: unknown[]) => renameFileFolder(...args),
  deleteFileFolder: (...args: unknown[]) => deleteFileFolder(...args),
}));

function file(id: string, filename: string, overrides: Partial<LibraryFile> = {}): LibraryFile {
  return {
    id,
    filename,
    mediaType: "application/pdf",
    sizeBytes: 1024,
    createdAt: "2026-01-02T03:04:05.000Z",
    modifiedAt: "2026-01-02T03:04:05.000Z",
    revision: 1,
    currentVersionId: id,
    archivedAt: null,
    owner: "user_1",
    origin: "uploaded",
    sourceChatId: null,
    sourceRunId: null,
    sharedWithCount: 0,
    inKnowledge: false,
    folderId: null,
    ...overrides,
  };
}

function renderRoute(
  sources: {
    mine?: readonly LibraryFile[];
    shared?: readonly LibraryFile[];
    archived?: readonly LibraryFile[];
    folders?: readonly FileFolder[];
    cursors?: { mine: string | null; shared: string | null; archived: string | null };
  } = {}
) {
  const Stub = createRemixStub([
    {
      path: "/files",
      Component: FilesIndex,
      loader: () => ({
        sources: {
          mine: sources.mine ?? [],
          shared: sources.shared ?? [],
          archived: sources.archived ?? [],
        },
        cursors: sources.cursors ?? { mine: null, shared: null, archived: null },
        viewerId: "user_1",
        folders: sources.folders ?? [],
      }),
    },
  ]);
  return render(<Stub initialEntries={["/files"]} />);
}

describe("Files library", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchFiles.mockResolvedValue({ files: [], nextCursor: null });
    fetchSharedWithMe.mockResolvedValue({ files: [], nextCursor: null });
    fetchArchivedFiles.mockResolvedValue({ files: [], nextCursor: null });
    searchFiles.mockResolvedValue([]);
    archiveFile.mockImplementation(async (_id: string, revision: number) =>
      file("mine", "mine.pdf", {
        revision: revision + 1,
        archivedAt: "2026-02-01T00:00:00.000Z",
      })
    );
    restoreArchivedFile.mockImplementation(async (_id: string, revision: number) =>
      file("archived", "archived.pdf", { revision: revision + 1 })
    );
    deleteFile.mockResolvedValue(undefined);
    shareFile.mockResolvedValue(undefined);
    fetchFileFolders.mockResolvedValue([]);
    createFileFolder.mockResolvedValue({
      id: "folder-1",
      name: "Engineering",
      parentId: null,
      createdAt: "2026-01-02T03:04:05.000Z",
      modifiedAt: "2026-01-02T03:04:05.000Z",
    });
    moveFile.mockImplementation(async (_id: string, folderId: string | null, revision: number) =>
      file("mine", "mine.pdf", { folderId, revision: revision + 1 })
    );
    uploadFile.mockReturnValue({
      done: Promise.resolve({
        id: "uploaded",
        filename: "uploaded.pdf",
        mediaType: "application/pdf",
        sizeBytes: 4,
        createdAt: "2026-01-02T03:04:05.000Z",
      }),
      cancel: vi.fn(),
    });
  });

  it("merges My Files and Shared with me, sorted by modified newest", async () => {
    renderRoute({
      mine: [file("mine", "mine.pdf", { modifiedAt: "2026-01-01T00:00:00.000Z" })],
      shared: [
        file("shared", "shared.pdf", {
          owner: "user_2",
          sharedWithCount: null,
          inKnowledge: null,
          modifiedAt: "2026-02-01T00:00:00.000Z",
        }),
      ],
    });

    await screen.findByText("shared.pdf");
    const names = screen
      .getAllByRole("button", { name: /^Preview / })
      .map((button) => button.getAttribute("aria-label"));
    expect(names).toEqual(["Preview shared.pdf", "Preview mine.pdf"]);
  });

  it.each([
    ["application/pdf", "report.pdf", "PDF", "pdf"],
    [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "deck.pptx",
      "Presentation",
      "presentation",
    ],
    ["text/csv", "data.csv", "Spreadsheet", "spreadsheet"],
    ["application/json", "data.json", "JSON", "json"],
    ["text/markdown", "notes.md", "Markdown", "markdown"],
    ["application/yaml", "config.yaml", "YAML", "yaml"],
    ["application/xml", "feed.xml", "XML", "xml"],
  ])("normalizes %s as a %s icon", (mediaType, filename, label, iconName) => {
    expect(fileTypeLabel({ mediaType, filename })).toBe(label);
    expect(fileTypeIconName({ mediaType, filename })).toBe(iconName);
    const { container, unmount } = render(
      <FileTypeIcon mediaType={mediaType} filename={filename} />
    );
    expect(container.querySelector(`[data-file-logo="${iconName}"]`)).not.toBeNull();
    unmount();
  });

  it("supports arrow, Home, and End keys across the tabs", async () => {
    const user = userEvent.setup();
    renderRoute();
    const all = await screen.findByRole("tab", { name: "All Files" });
    all.focus();

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "My Files" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Trash" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(all).toHaveFocus();
  });

  it("uses server filename search for active Files", async () => {
    searchFiles.mockResolvedValue([file("result", "pricing.pdf")]);
    renderRoute({ mine: [file("mine", "mine.pdf")] });

    await userEvent.type(
      await screen.findByRole("searchbox", { name: "Search filenames" }),
      "pricing"
    );

    expect(await screen.findByText("pricing.pdf")).toBeInTheDocument();
    expect(searchFiles).toHaveBeenCalledWith("pricing", 20, expect.any(AbortSignal));
    expect(screen.queryByText("mine.pdf")).toBeNull();
  });

  it("filters the loaded Trash page by filename without server search", async () => {
    const user = userEvent.setup();
    renderRoute({
      archived: [
        file("a", "old-plan.pdf", { archivedAt: "2026-02-01T00:00:00.000Z" }),
        file("b", "receipt.pdf", { archivedAt: "2026-02-02T00:00:00.000Z" }),
      ],
    });

    await user.click(await screen.findByRole("tab", { name: "Trash" }));
    await user.type(screen.getByRole("searchbox", { name: "Search filenames" }), "receipt");

    expect(screen.getByText("receipt.pdf")).toBeInTheDocument();
    expect(screen.queryByText("old-plan.pdf")).toBeNull();
    expect(searchFiles).not.toHaveBeenCalled();
  });

  it("moves an active File to the trash instead of offering permanent delete", async () => {
    const user = userEvent.setup();
    renderRoute({ mine: [file("mine", "mine.pdf")] });

    await user.click(await screen.findByRole("button", { name: "Actions for mine.pdf" }));
    expect(screen.queryByRole("menuitem", { name: "Delete permanently" })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "Move to trash" }));
    expect(screen.getByText(/leaves active lists/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Move to trash" }));

    await waitFor(() => expect(archiveFile).toHaveBeenCalledWith("mine", 1));
    expect(screen.queryByText("mine.pdf")).toBeNull();
  });

  it("permanently deletes only from Trash with the current revision", async () => {
    const user = userEvent.setup();
    renderRoute({
      archived: [
        file("archived", "archived.pdf", {
          revision: 4,
          archivedAt: "2026-02-01T00:00:00.000Z",
        }),
      ],
    });

    await user.click(await screen.findByRole("tab", { name: "Trash" }));
    await user.click(screen.getByRole("button", { name: "Actions for archived.pdf" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete permanently" }));
    await user.click(screen.getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => expect(deleteFile).toHaveBeenCalledWith("archived", 4));
    expect(screen.queryByText("archived.pdf")).toBeNull();
  });

  it("uploads with the chosen name and staged sharing access", async () => {
    const user = userEvent.setup();
    renderRoute();

    await user.click(await screen.findByRole("button", { name: "Add file" }));
    expect(screen.getByRole("tab", { name: "Upload" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /Google Drive/ })).toBeDisabled();

    const input = document.querySelector('input[type="file"]');
    expect(input).not.toBeNull();
    await user.upload(
      input as HTMLInputElement,
      new File(["image"], "photo.png", { type: "image/png" })
    );
    const name = screen.getByLabelText("File name");
    await user.clear(name);
    await user.type(name, "team-photo.png");
    await user.type(screen.getByLabelText("Person principal id"), "person-2");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add file" }));

    await waitFor(() =>
      expect(uploadFile).toHaveBeenCalledWith(
        expect.any(File),
        expect.any(Function),
        "team-photo.png",
        undefined
      )
    );
    expect(shareFile).toHaveBeenCalledWith("uploaded", { kind: "user", id: "person-2" });
  });

  it("accepts a file dropped onto the upload target", async () => {
    const user = userEvent.setup();
    renderRoute();
    await user.click(await screen.findByRole("button", { name: "Add file" }));

    const target = screen.getByRole("button", {
      name: /Drag and drop files, or choose them/,
    });
    const dropped = new File(["image"], "dropped.png", { type: "image/png" });
    fireEvent.drop(target, {
      dataTransfer: {
        files: {
          0: dropped,
          length: 1,
          item: (index: number) => (index === 0 ? dropped : null),
        },
        types: ["Files"],
      },
    });

    expect(screen.getByLabelText("File name")).toHaveValue("dropped.png");
    expect(
      screen.getByRole("button", { name: /Drop another file, or choose one/ })
    ).toBeInTheDocument();
    expect(screen.getByText("Coming soon")).toHaveClass("bg-status-warning-surface");
  });

  it("uploads up to ten selected Files as one batch", async () => {
    const user = userEvent.setup();
    renderRoute();

    await user.click(await screen.findByRole("button", { name: "Add file" }));
    const input = document.querySelector('input[type="file"]');
    await user.upload(input as HTMLInputElement, [
      new File(["one"], "one.txt", { type: "text/plain" }),
      new File(["two"], "two.txt", { type: "text/plain" }),
    ]);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add files" }));

    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(2));
    expect(uploadFile).toHaveBeenNthCalledWith(
      1,
      expect.any(File),
      expect.any(Function),
      "one.txt",
      undefined
    );
    expect(uploadFile).toHaveBeenNthCalledWith(
      2,
      expect.any(File),
      expect.any(Function),
      "two.txt",
      undefined
    );
  });

  it("accepts Word, Excel, and PowerPoint files from the native picker", async () => {
    const user = userEvent.setup();
    renderRoute();

    await user.click(await screen.findByRole("button", { name: "Add file" }));
    const input = document.querySelector('input[type="file"]');
    await user.upload(input as HTMLInputElement, [
      new File(["doc"], "report.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
      new File(["sheet"], "forecast.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      new File(["slides"], "review.pptx", {
        type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }),
    ]);

    expect(screen.getByLabelText("File name for report.docx")).toBeInTheDocument();
    expect(screen.getByLabelText("File name for forecast.xlsx")).toBeInTheDocument();
    expect(screen.getByLabelText("File name for review.pptx")).toBeInTheDocument();
  });

  it("refuses a local batch above ten Files", async () => {
    const user = userEvent.setup();
    renderRoute();

    await user.click(await screen.findByRole("button", { name: "Add file" }));
    const input = document.querySelector('input[type="file"]');
    await user.upload(
      input as HTMLInputElement,
      Array.from(
        { length: 11 },
        (_, index) => new File([String(index)], `${index}.txt`, { type: "text/plain" })
      )
    );

    expect(screen.getByRole("alert")).toHaveTextContent("up to 10 files");
    expect(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Add file" })
    ).toBeDisabled();
  });

  it("creates folders, opens them, and moves owned Files into them", async () => {
    const user = userEvent.setup();
    renderRoute({ mine: [file("mine", "mine.pdf")] });

    await user.click(await screen.findByRole("button", { name: "New folder" }));
    await user.type(screen.getByLabelText("Folder name"), "Engineering");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create" }));

    expect(createFileFolder).toHaveBeenCalledWith("Engineering", null);
    await user.click(await screen.findByRole("button", { name: "Open Engineering" }));
    expect(screen.getByText("Engineering")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Files home" }));
    await user.click(screen.getByRole("button", { name: "Actions for mine.pdf" }));
    await user.click(screen.getByRole("menuitem", { name: "Move" }));
    await user.selectOptions(screen.getByLabelText("Destination folder"), "folder-1");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Move" }));

    expect(moveFile).toHaveBeenCalledWith("mine", "folder-1", 1);
  });

  it("pulls the remaining pages in before narrowing, so a filter is not a half-answer", async () => {
    const user = userEvent.setup();
    // The image lives on page two. Filtering only what is already loaded would report that this
    // library holds no images at all, which is worse than saying nothing.
    fetchFiles.mockResolvedValue({
      files: [file("later", "diagram.png", { mediaType: "image/png" })],
      nextCursor: null,
    });
    renderRoute({
      mine: [file("first", "notes.pdf")],
      cursors: { mine: "page-2", shared: null, archived: null },
    });

    await user.selectOptions(await screen.findByLabelText("File type"), "images");

    expect(await screen.findByText("diagram.png")).toBeInTheDocument();
    expect(fetchFiles).toHaveBeenCalledWith(expect.objectContaining({ after: "page-2" }));
  });

  it("renames a folder in place", async () => {
    const user = userEvent.setup();
    renameFileFolder.mockResolvedValue({
      id: "folder-1",
      name: "Engineering",
      parentId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      modifiedAt: "2026-01-01T00:00:00.000Z",
    });
    renderRoute({
      folders: [
        {
          id: "folder-1",
          name: "Enginering",
          parentId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          modifiedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    await user.click(await screen.findByRole("button", { name: "Rename Enginering" }));
    const field = await screen.findByLabelText("Folder name");
    expect(field).toHaveValue("Enginering");
    await user.clear(field);
    await user.type(field, "Engineering");
    await user.click(screen.getByRole("button", { name: "Rename" }));

    expect(renameFileFolder).toHaveBeenCalledWith("folder-1", "Engineering");
    expect(await screen.findByRole("button", { name: "Open Engineering" })).toBeInTheDocument();
  });

  it("says why a folder that still holds something was not deleted", async () => {
    const user = userEvent.setup();
    deleteFileFolder.mockRejectedValue(
      new Error("Move or delete what this folder holds before deleting it.")
    );
    renderRoute({
      folders: [
        {
          id: "folder-1",
          name: "Reports",
          parentId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          modifiedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    await user.click(await screen.findByRole("button", { name: "Delete Reports" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Move or delete what this folder holds before deleting it."
    );
    // The folder is still there, because refusing must not look like it worked.
    expect(screen.getByRole("button", { name: "Open Reports" })).toBeInTheDocument();
  });

  it("uploads a File into the open folder", async () => {
    const user = userEvent.setup();
    renderRoute({
      folders: [
        {
          id: "folder-1",
          name: "Engineering",
          parentId: null,
          createdAt: "2026-01-02T03:04:05.000Z",
          modifiedAt: "2026-01-02T03:04:05.000Z",
        },
      ],
    });

    await user.click(await screen.findByRole("button", { name: "Open Engineering" }));
    await user.click(screen.getByRole("button", { name: "Add file" }));
    const input = document.querySelector('input[type="file"]');
    await user.upload(
      input as HTMLInputElement,
      new File(["report"], "report.txt", { type: "text/plain" })
    );
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add file" }));

    await waitFor(() =>
      expect(uploadFile).toHaveBeenCalledWith(
        expect.any(File),
        expect.any(Function),
        "report.txt",
        "folder-1"
      )
    );
  });
});
