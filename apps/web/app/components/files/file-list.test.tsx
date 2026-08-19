import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
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
    owner: "user_1",
    origin: "uploaded",
    sourceChatId: null,
    sharedWithCount: null,
    ...overrides,
  };
}

function renderList(
  files: readonly LibraryFile[],
  onAttach?: (f: LibraryFile) => void,
  onShare?: (f: LibraryFile) => void,
  onDelete?: (f: LibraryFile) => void
) {
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => (
        <FileList
          files={files}
          viewerId="user_1"
          onPreview={() => {}}
          {...(onAttach ? { onAttach } : {})}
          {...(onShare ? { onShare } : {})}
          {...(onDelete ? { onDelete } : {})}
        />
      ),
    },
  ]);
  return render(<Stub initialEntries={["/"]} />);
}

describe("FileList", () => {
  it("says on the row how many people a File is shared with, and stays silent when none", () => {
    renderList([
      libraryFile({ id: "shared", filename: "shared.pdf", sharedWithCount: 3 }),
      libraryFile({ id: "one", filename: "one.pdf", sharedWithCount: 1 }),
      libraryFile({ id: "private", filename: "private.pdf", sharedWithCount: 0 }),
    ]);

    expect(screen.getByText("Shared with 3")).toBeTruthy();
    expect(screen.getByText("Shared with 1")).toBeTruthy();
    expect(screen.queryByText("Shared with 0")).toBeNull();
  });

  it("offers Share on a File the viewer owns and withholds it on one shared with them", () => {
    renderList(
      [
        libraryFile({ id: "mine", filename: "mine.pdf", owner: "user_1" }),
        libraryFile({ id: "theirs", filename: "theirs.pdf", owner: "user_2" }),
      ],
      undefined,
      () => {}
    );

    expect(screen.getByRole("button", { name: "Share mine.pdf" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Share theirs.pdf" })).toBeNull();
  });

  it("tells an agent-generated File apart from an uploaded one in words, not only colour", () => {
    renderList([
      libraryFile({ id: "a", filename: "made.pdf", origin: "generated" }),
      libraryFile({ id: "b", filename: "sent.pdf", origin: "uploaded" }),
    ]);

    expect(screen.getByText("Agent-generated")).toBeTruthy();
    expect(screen.getByText("Uploaded")).toBeTruthy();
  });

  it("names the viewer as themselves rather than showing their own id back to them", () => {
    renderList([libraryFile({ owner: "user_1" })]);
    expect(screen.getByText("you")).toBeTruthy();
  });

  it("links to the Chat a File came from, and shows no link when it has none", () => {
    renderList([libraryFile({ id: "a", sourceChatId: "conv_9" })]);
    expect(screen.getByRole("link", { name: /from a chat/i }).getAttribute("href")).toBe(
      "/chat/conv_9"
    );

    renderList([libraryFile({ id: "b", sourceChatId: null })]);
    expect(screen.queryAllByRole("link", { name: /from a chat/i })).toHaveLength(1);
  });

  it("offers a preview for a PDF and a plain name for a type it cannot show", () => {
    renderList([libraryFile({ id: "a", filename: "report.pdf", mediaType: "application/pdf" })]);
    expect(screen.getByRole("button", { name: "report.pdf" })).toBeTruthy();

    renderList([libraryFile({ id: "b", filename: "notes.txt", mediaType: "text/plain" })]);
    expect(screen.queryByRole("button", { name: "notes.txt" })).toBeNull();
  });

  it("hands a File back to the caller to attach, rather than uploading it again", () => {
    const onAttach = vi.fn();
    renderList([libraryFile({ filename: "report.pdf" })], onAttach);

    screen.getByRole("button", { name: "Attach report.pdf to a new chat" }).click();

    expect(onAttach).toHaveBeenCalledWith(expect.objectContaining({ id: "file_1" }));
  });

  it("shows a size a person can read", () => {
    renderList([libraryFile({ sizeBytes: 2048 })]);
    expect(screen.getByText(/2\.0 KB/)).toBeTruthy();
  });
});

describe("a download that fails", () => {
  it("says so, rather than looking like a download the browser handled quietly", async () => {
    const files = await import("~/lib/files");
    vi.mocked(files.fetchFileObjectUrl).mockRejectedValueOnce(new Error("gone"));
    renderList([libraryFile({ filename: "report.pdf" })]);

    screen.getByRole("button", { name: "Download report.pdf" }).click();

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Download failed");
  });
});

describe("deleting from the library", () => {
  it("offers Delete on a File you own and never on one shared with you", () => {
    renderList(
      [
        libraryFile({ id: "mine", filename: "mine.pdf", owner: "user_1" }),
        libraryFile({ id: "theirs", filename: "theirs.pdf", owner: "user_2" }),
      ],
      undefined,
      undefined,
      () => {}
    );

    expect(screen.getByRole("button", { name: "Delete mine.pdf" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete theirs.pdf" })).toBeNull();
  });

  it("asks the caller to confirm rather than destroying on the click itself", () => {
    const onDelete = vi.fn();
    renderList([libraryFile({ filename: "report.pdf" })], undefined, undefined, onDelete);

    screen.getByRole("button", { name: "Delete report.pdf" }).click();

    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: "file_1" }));
  });
});
