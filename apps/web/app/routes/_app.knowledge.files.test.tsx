import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FilePage, LibraryFile } from "~/lib/files";
import FilesIndex from "./_app.knowledge.files";

const fetchFiles = vi.fn<() => Promise<FilePage>>();
const fetchSharedWithMe = vi.fn<() => Promise<FilePage>>();

vi.mock("~/lib/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/files")>()),
  fetchFiles: (...args: unknown[]) => fetchFiles(...(args as [])),
  fetchSharedWithMe: (...args: unknown[]) => fetchSharedWithMe(...(args as [])),
  fetchFileObjectUrl: vi.fn(),
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
});
