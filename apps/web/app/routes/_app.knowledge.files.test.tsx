import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FilePage, LibraryFile } from "~/lib/files";
import FilesIndex from "./_app.knowledge.files";

const fetchFiles = vi.fn<() => Promise<FilePage>>();
const fetchSharedWithMe = vi.fn<() => Promise<FilePage>>();
const deleteFile = vi.fn<(id: string) => Promise<void>>();
const addFileToKnowledge = vi.fn<(id: string) => Promise<void>>();
const removeFileFromKnowledge = vi.fn<(id: string) => Promise<void>>();

vi.mock("~/lib/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/files")>()),
  fetchFiles: (...args: unknown[]) => fetchFiles(...(args as [])),
  fetchSharedWithMe: (...args: unknown[]) => fetchSharedWithMe(...(args as [])),
  fetchFileObjectUrl: vi.fn(),
  deleteFile: (...args: unknown[]) => deleteFile(...(args as [string])),
  addFileToKnowledge: (...args: unknown[]) => addFileToKnowledge(...(args as [string])),
  removeFileFromKnowledge: (...args: unknown[]) => removeFileFromKnowledge(...(args as [string])),
}));

function file(id: string, filename: string, owner = "user_1"): LibraryFile {
  return {
    id,
    filename,
    mediaType: "application/pdf",
    sizeBytes: 1024,
    createdAt: "2026-01-02T03:04:05.000Z",
    owner,
    origin: "uploaded",
    sourceChatId: null,
    sourceRunId: null,
    sharedWithCount: null,
  };
}

function renderRoute(loaded: { files: readonly LibraryFile[] }) {
  const Stub = createRemixStub([
    {
      path: "/knowledge/files",
      Component: FilesIndex,
      loader: () => ({ files: loaded.files, nextCursor: null, viewerId: "user_1" }),
    },
  ]);
  return render(<Stub initialEntries={["/knowledge/files"]} />);
}

describe("Files library", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchFiles.mockResolvedValue({ files: [file("a", "yours.pdf")], nextCursor: null });
    fetchSharedWithMe.mockResolvedValue({
      files: [file("b", "theirs.pdf", "user_2")],
      nextCursor: null,
    });
    deleteFile.mockResolvedValue(undefined);
  });

  it("swaps to Files shared with the viewer, and says so when there are none", async () => {
    const user = userEvent.setup();
    renderRoute({ files: [file("a", "yours.pdf")] });
    expect(await screen.findByText("yours.pdf")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Shared with you" }));
    expect(await screen.findByText("theirs.pdf")).toBeInTheDocument();
    expect(screen.queryByText("yours.pdf")).toBeNull();

    fetchFiles.mockResolvedValue({ files: [], nextCursor: null });
    await user.click(screen.getByRole("tab", { name: "Yours" }));
    expect(await screen.findByText("No files yet")).toBeInTheDocument();
  });

  it("ignores a slow answer for a tab the viewer has already left", async () => {
    const user = userEvent.setup();
    let releaseShared: (page: FilePage) => void = () => {};
    fetchSharedWithMe.mockReturnValue(
      new Promise<FilePage>((resolve) => {
        releaseShared = resolve;
      })
    );
    renderRoute({ files: [file("a", "yours.pdf")] });
    await screen.findByText("yours.pdf");

    await user.click(screen.getByRole("tab", { name: "Shared with you" }));
    await user.click(screen.getByRole("tab", { name: "Yours" }));
    await screen.findByText("yours.pdf");

    // The abandoned tab answers last. It must not paint over the tab the viewer is looking at.
    releaseShared({ files: [file("b", "theirs.pdf", "user_2")], nextCursor: null });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Yours" })).toHaveAttribute("aria-selected", "true")
    );
    expect(screen.queryByText("theirs.pdf")).toBeNull();
    expect(screen.getByText("yours.pdf")).toBeInTheDocument();
  });

  it("warns that a delete is permanent before it does anything", async () => {
    const user = userEvent.setup();
    renderRoute({ files: [file("a", "yours.pdf")] });
    await screen.findByText("yours.pdf");

    await user.click(screen.getByRole("button", { name: "Delete yours.pdf" }));

    expect(await screen.findByText(/cannot be undone/i)).toBeInTheDocument();
    expect(screen.getByText(/erased for good/i)).toBeInTheDocument();
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it("leaves the File alone when the warning is dismissed", async () => {
    const user = userEvent.setup();
    renderRoute({ files: [file("a", "yours.pdf")] });
    await screen.findByText("yours.pdf");

    await user.click(screen.getByRole("button", { name: "Delete yours.pdf" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(deleteFile).not.toHaveBeenCalled();
    expect(screen.getByText("yours.pdf")).toBeInTheDocument();
  });

  it("drops the row once the delete lands, without re-paging from the top", async () => {
    const user = userEvent.setup();
    renderRoute({ files: [file("a", "yours.pdf"), file("b", "kept.pdf")] });
    await screen.findByText("yours.pdf");
    fetchFiles.mockClear();

    await user.click(screen.getByRole("button", { name: "Delete yours.pdf" }));
    await user.click(screen.getByRole("button", { name: "Delete for good" }));

    await waitFor(() => expect(screen.queryByText("yours.pdf")).toBeNull());
    expect(deleteFile).toHaveBeenCalledWith("a");
    expect(screen.getByText("kept.pdf")).toBeInTheDocument();
    expect(fetchFiles).not.toHaveBeenCalled();
  });

  it("keeps the File on screen and says so when the delete is refused", async () => {
    const user = userEvent.setup();
    deleteFile.mockRejectedValue(new Error("That file could not be deleted."));
    renderRoute({ files: [file("a", "yours.pdf")] });
    await screen.findByText("yours.pdf");

    await user.click(screen.getByRole("button", { name: "Delete yours.pdf" }));
    await user.click(screen.getByRole("button", { name: "Delete for good" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That file could not be deleted.");
    expect(screen.getByText("yours.pdf")).toBeInTheDocument();
  });
});

describe("adding a file to knowledge", () => {
  beforeEach(() => {
    addFileToKnowledge.mockReset().mockResolvedValue(undefined);
    removeFileFromKnowledge.mockReset().mockResolvedValue(undefined);
    fetchFiles.mockResolvedValue({ files: [], nextCursor: null });
    fetchSharedWithMe.mockResolvedValue({ files: [], nextCursor: null });
  });

  it("offers it as its own action, so uploading never publishes a file by itself", async () => {
    renderRoute({ files: [{ ...file("f1", "handbook.pdf"), inKnowledge: false }] });
    await userEvent.click(await screen.findByRole("button", { name: /add handbook.pdf/i }));
    await waitFor(() => expect(addFileToKnowledge).toHaveBeenCalledWith("f1"));
    expect(await screen.findByText("In knowledge")).toBeTruthy();
  });

  it("takes it back out again, and says so", async () => {
    renderRoute({ files: [{ ...file("f1", "handbook.pdf"), inKnowledge: true }] });
    await userEvent.click(await screen.findByRole("button", { name: /remove handbook.pdf/i }));
    await waitFor(() => expect(removeFileFromKnowledge).toHaveBeenCalledWith("f1"));
    expect(screen.queryByText("In knowledge")).toBeNull();
  });

  it("puts the row back when the request is refused, rather than lying about it", async () => {
    addFileToKnowledge.mockRejectedValue(new Error("This deployment cannot add files."));
    renderRoute({ files: [{ ...file("f1", "handbook.pdf"), inKnowledge: false }] });
    await userEvent.click(await screen.findByRole("button", { name: /add handbook.pdf/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/cannot add files/i);
    expect(screen.queryByText("In knowledge")).toBeNull();
  });

  it("does not offer the action on a file someone else owns", async () => {
    renderRoute({ files: [file("f2", "theirs.pdf", "user_2")] });
    await screen.findByText("theirs.pdf");
    expect(screen.queryByRole("button", { name: /knowledge/i })).toBeNull();
  });
});
