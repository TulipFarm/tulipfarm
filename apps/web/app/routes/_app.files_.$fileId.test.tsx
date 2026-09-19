import { createRemixStub } from "@remix-run/testing";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Link } from "~/components/ui/link";
import type { FileKnowledgeReceipt, FileVersion, LibraryFile } from "~/lib/files";
import FileDetailRoute from "./_app.files_.$fileId";

const replaceFile = vi.fn();
const restoreFileVersion = vi.fn();
const archiveFile = vi.fn();
const restoreArchivedFile = vi.fn();
const deleteFile = vi.fn();
const fetchFileVersions = vi.fn();
const fetchFile = vi.fn();
const addFileToKnowledge = vi.fn();
const removeFileFromKnowledge = vi.fn();

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
  fetchFile: (...args: unknown[]) => fetchFile(...args),
  addFileToKnowledge: (...args: unknown[]) => addFileToKnowledge(...args),
  removeFileFromKnowledge: (...args: unknown[]) => removeFileFromKnowledge(...args),
}));

function receipt(overrides: Partial<FileKnowledgeReceipt> = {}): FileKnowledgeReceipt {
  return {
    requestId: "request_1",
    fileId: "file_1",
    versionId: "version_2",
    converterRevision: "anydoc-2",
    status: "queued",
    requestedAt: "2026-09-19T00:00:00.000Z",
    completedAt: null,
    reason: null,
    indexedAt: null,
    indexedConverterRevision: null,
    truncated: false,
    ...overrides,
  };
}

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
    fetchFile.mockReset().mockResolvedValue(file());
    addFileToKnowledge.mockReset().mockResolvedValue(undefined);
    removeFileFromKnowledge.mockReset().mockResolvedValue(undefined);
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
    await waitFor(() => expect(fetchFileVersions).toHaveBeenCalledWith("file_1"));
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

  it("shows accepted Add as queued, never as already in Knowledge", async () => {
    fetchFile.mockResolvedValue(file({ knowledgeRequested: true, knowledgeReceipt: receipt() }));
    renderRoute();
    await userEvent.click(await screen.findByRole("button", { name: "Add to Knowledge" }));
    expect(await screen.findByText("Knowledge queued")).toBeInTheDocument();
    expect(screen.queryByText("In Knowledge")).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh Knowledge" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove from Knowledge" })).toBeEnabled();
    expect(addFileToKnowledge).toHaveBeenCalledOnce();
    expect(fetchFile).toHaveBeenCalledWith("file_1", expect.any(AbortSignal));
  });

  it("refreshes the owner File and retains the previous result on refusal", async () => {
    fetchFile.mockResolvedValue(
      file({
        inKnowledge: true,
        knowledgeRequested: true,
        knowledgeReceipt: receipt({ status: "refused", reason: "needs_ocr" }),
      })
    );
    renderRoute(file({ inKnowledge: true, knowledgeRequested: true }));
    await userEvent.click(await screen.findByRole("button", { name: "Refresh Knowledge" }));
    expect(await screen.findByText("Knowledge refused")).toBeInTheDocument();
    expect(screen.getByText("Previous Knowledge result is still available.")).toBeInTheDocument();
    expect(screen.getByText("In Knowledge")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh Knowledge" })).toBeEnabled();
    expect(addFileToKnowledge).toHaveBeenCalledWith("file_1");
    expect(removeFileFromKnowledge).not.toHaveBeenCalled();
  });

  it("removes pending opt-in even before any content is published", async () => {
    renderRoute(file({ knowledgeRequested: true, knowledgeReceipt: receipt() }));
    await userEvent.click(await screen.findByRole("button", { name: "Remove from Knowledge" }));
    await screen.findByRole("button", { name: "Add to Knowledge" });
    expect(removeFileFromKnowledge).toHaveBeenCalledWith("file_1");
    expect(addFileToKnowledge).not.toHaveBeenCalled();
  });

  it.each([
    { canManage: false, owner: "user_2" },
    { canManage: false },
    { archivedAt: "2026-09-19T00:00:00.000Z" },
    { mediaType: "image/png" },
    { knowledgeRequested: false },
  ])("does not offer refresh for ineligible Files: %j", async (overrides) => {
    renderRoute(file({ inKnowledge: true, knowledgeRequested: true, ...overrides }));
    await screen.findByRole("heading", { name: "report.pdf" });
    expect(screen.queryByRole("button", { name: "Refresh Knowledge" })).toBeNull();
  });

  it("deduplicates clicks and keeps refresh disabled until metadata arrives", async () => {
    let resolve: () => void = () => {};
    addFileToKnowledge.mockReturnValue(
      new Promise<void>((done) => {
        resolve = done;
      })
    );
    renderRoute(file({ inKnowledge: true }));
    const refresh = await screen.findByRole("button", { name: "Refresh Knowledge" });
    fireEvent.click(refresh);
    fireEvent.click(refresh);
    expect(addFileToKnowledge).toHaveBeenCalledOnce();
    expect(refresh).toBeDisabled();
    await act(async () => resolve());
    await waitFor(() => expect(fetchFile).toHaveBeenCalledOnce());
  });

  it("reports metadata fetch failures without pretending an accepted request completed", async () => {
    fetchFile.mockRejectedValue(new Error("VENDOR_ERROR"));
    renderRoute();
    await userEvent.click(await screen.findByRole("button", { name: "Add to Knowledge" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("metadata could not be loaded");
    expect(screen.queryByText("Knowledge completed")).toBeNull();
    expect(screen.queryByText("In Knowledge")).toBeNull();
    expect(screen.queryByText(/VENDOR_ERROR/)).toBeNull();
  });

  it("does not retain obsolete Knowledge after replacing a version", async () => {
    fetchFile.mockResolvedValue(
      file({
        revision: 3,
        currentVersionId: "version_3",
        knowledgeRequested: true,
        knowledgeReceipt: receipt({ versionId: "version_3" }),
      })
    );
    renderRoute(file({ inKnowledge: true, knowledgeRequested: true }));
    await userEvent.upload(
      await screen.findByLabelText("Choose replacement for report.pdf"),
      new File(["next"], "report.pdf", { type: "application/pdf" })
    );
    expect(await screen.findByText("Knowledge queued")).toBeInTheDocument();
    expect(screen.queryByText("In Knowledge")).toBeNull();
    expect(screen.queryByText("Previous Knowledge result is still available.")).toBeNull();
  });

  it("suppresses a metadata result after navigating to a different File", async () => {
    let resolve: (value: LibraryFile) => void = () => {};
    fetchFile.mockReturnValue(
      new Promise<LibraryFile>((done) => {
        resolve = done;
      })
    );
    const Stub = createRemixStub([
      {
        path: "/files/:fileId",
        Component: () => (
          <>
            <Link to="/files/file_2">Next File</Link>
            <FileDetailRoute />
          </>
        ),
        loader: ({ params }) => ({
          file:
            params.fileId === "file_1"
              ? file()
              : file({ id: "file_2", filename: "next.pdf", canManage: false }),
          versions: [],
          viewerId: "user_1",
        }),
      },
    ]);
    render(<Stub initialEntries={["/files/file_1"]} />);
    await userEvent.click(await screen.findByRole("button", { name: "Add to Knowledge" }));
    await waitFor(() => expect(fetchFile).toHaveBeenCalledOnce());
    const signal = fetchFile.mock.calls[0]?.[1] as AbortSignal;
    await userEvent.click(screen.getByRole("link", { name: "Next File" }));
    await screen.findByRole("heading", { name: "next.pdf" });
    expect(signal.aborted).toBe(true);
    await act(async () =>
      resolve(
        file({
          inKnowledge: true,
          knowledgeReceipt: receipt({ status: "succeeded" }),
        })
      )
    );
    expect(screen.queryByRole("heading", { name: "report.pdf" })).toBeNull();
    expect(screen.queryByText("Knowledge completed")).toBeNull();
    expect(screen.queryByText("In Knowledge")).toBeNull();
  });
});
