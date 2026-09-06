import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileVersion, LibraryFile } from "~/lib/files";
import FileDetailRoute from "./_app.files.$fileId";

const replaceFile = vi.fn();
const restoreFileVersion = vi.fn();
const archiveFile = vi.fn();
const restoreArchivedFile = vi.fn();
const deleteFile = vi.fn();
const fetchFileVersions = vi.fn();

vi.mock("~/lib/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/files")>()),
  fetchFileObjectUrl: vi.fn().mockResolvedValue("blob:preview"),
  fetchFileVersionObjectUrl: vi.fn().mockResolvedValue("blob:version"),
  replaceFile: (...args: unknown[]) => replaceFile(...args),
  restoreFileVersion: (...args: unknown[]) => restoreFileVersion(...args),
  archiveFile: (...args: unknown[]) => archiveFile(...args),
  restoreArchivedFile: (...args: unknown[]) => restoreArchivedFile(...args),
  deleteFile: (...args: unknown[]) => deleteFile(...args),
  fetchFileVersions: (...args: unknown[]) => fetchFileVersions(...args),
}));

function file(overrides: Partial<LibraryFile> = {}): LibraryFile {
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
    canManage: true,
    folderId: null,
    origin: "uploaded",
    sourceChatId: null,
    sourceRunId: null,
    sharedWithCount: 0,
    inKnowledge: false,
    ...overrides,
  };
}

function version(overrides: Partial<FileVersion> = {}): FileVersion {
  return {
    id: "version_1",
    versionNumber: 1,
    mediaType: "application/pdf",
    sizeBytes: 1024,
    actorKind: "principal",
    actorId: "user_1",
    reason: "created",
    sourceChatId: null,
    sourceRunId: null,
    restoredFromVersionId: null,
    createdAt: "2026-01-02T03:04:05.000Z",
    ...overrides,
  };
}

function renderRoute(current = file(), versions: readonly FileVersion[] = [version()]) {
  const Stub = createRemixStub([
    {
      path: "/files/:fileId",
      Component: FileDetailRoute,
      loader: () => ({ file: current, versions, viewerId: "user_1" }),
    },
    { path: "/files", Component: () => <p>Files library</p> },
  ]);
  return render(<Stub initialEntries={[`/files/${current.id}`]} />);
}

describe("File detail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchFileVersions.mockResolvedValue([version({ id: "version_3", versionNumber: 3 })]);
    replaceFile.mockResolvedValue(
      file({ revision: 3, currentVersionId: "version_3", sizeBytes: 4096 })
    );
    restoreFileVersion.mockResolvedValue(file({ revision: 3, currentVersionId: "version_3" }));
    archiveFile.mockResolvedValue(file({ revision: 3, archivedAt: "2026-03-01T00:00:00.000Z" }));
    restoreArchivedFile.mockResolvedValue(file({ revision: 4 }));
    deleteFile.mockResolvedValue(undefined);
  });

  it("shows metadata, preview, current actions, and version history", async () => {
    renderRoute(file({ sharedWithCount: 2 }), [
      version({ id: "version_2", versionNumber: 2, reason: "replaced" }),
      version(),
    ]);

    expect(await screen.findByText("Shared with 2")).toBeInTheDocument();
    expect(await screen.findByTitle("report.pdf")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Attach" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
    expect(screen.getByText("v2")).toBeInTheDocument();
    expect(screen.getByText("Current")).toBeInTheDocument();
  });

  it("replaces content at the current revision and reloads version history", async () => {
    renderRoute();

    await userEvent.upload(
      await screen.findByLabelText("Choose replacement for report.pdf"),
      new File(["next"], "report.pdf", { type: "application/pdf" })
    );

    await waitFor(() => expect(replaceFile).toHaveBeenCalledWith("file_1", 2, expect.any(File)));
    expect(fetchFileVersions).toHaveBeenCalledWith("file_1");
  });

  it("restores an old version as a new latest version", async () => {
    renderRoute();

    await userEvent.click(await screen.findByRole("button", { name: "Restore version 1" }));

    await waitFor(() => expect(restoreFileVersion).toHaveBeenCalledWith("file_1", "version_1", 2));
  });

  it("offers restore and permanent delete only while archived", async () => {
    const user = userEvent.setup();
    renderRoute(file({ revision: 4, archivedAt: "2026-03-01T00:00:00.000Z" }));

    await screen.findByText("In trash");
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Replace content" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Delete permanently" }));
    await user.click(screen.getAllByRole("button", { name: "Delete permanently" })[1] as Element);

    await waitFor(() => expect(deleteFile).toHaveBeenCalledWith("file_1", 4));
    expect(await screen.findByText("Files library")).toBeInTheDocument();
  });
});
