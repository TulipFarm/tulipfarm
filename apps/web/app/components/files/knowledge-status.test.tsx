import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FileKnowledgeReceipt, fetchFile, type LibraryFile } from "~/lib/files";
import { KnowledgeStatus, useKnowledgePolling } from "./knowledge-status";

vi.mock("~/lib/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/files")>()),
  fetchFile: vi.fn(),
}));

function file(
  receipt: Partial<FileKnowledgeReceipt> = {},
  overrides: Partial<LibraryFile> = {}
): LibraryFile {
  return {
    id: "file_1",
    filename: "report.docx",
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sizeBytes: 2048,
    createdAt: "2026-01-02T03:04:05.000Z",
    currentVersionId: "version_1",
    owner: "user_1",
    canManage: true,
    folderId: null,
    origin: "uploaded",
    sourceChatId: null,
    sourceRunId: null,
    sharedWithCount: 0,
    inKnowledge: true,
    knowledgeRequested: true,
    knowledgeReceipt: {
      requestId: "request_1",
      fileId: "file_1",
      versionId: "version_1",
      converterRevision: "anydoc-2",
      status: "queued",
      requestedAt: "2026-09-19T00:00:00.000Z",
      completedAt: null,
      reason: null,
      indexedAt: "2026-09-01T00:00:00.000Z",
      indexedConverterRevision: "anydoc-1",
      truncated: false,
      ...receipt,
    },
    ...overrides,
  };
}

describe("Knowledge receipt", () => {
  it.each([
    ["queued", "queued"],
    ["processing", "processing"],
    ["succeeded", "completed"],
    ["refused", "refused"],
    ["failed", "failed"],
  ] as const)("distinguishes %s from completion", (status, label) => {
    render(<KnowledgeStatus file={file({ status })} />);
    expect(screen.getByText(`Knowledge ${label}`)).toBeInTheDocument();
    expect(screen.queryByText("Previous Knowledge result is still available.") !== null).toBe(
      status !== "succeeded"
    );
  });

  it.each([
    ["needs_ocr", "needs OCR"],
    ["encrypted", "password-protected"],
    ["unreadable", "could not be read"],
    ["resource_limit", "processing limits"],
    ["unsupported_media_type", "not supported"],
    ["no_text_layer", "no text layer"],
    ["no_text", "No text was found"],
    ["no_space", "not enough storage"],
    ["withdrawn", "withdrawn"],
    ["changed", "File changed"],
    ["converter_unavailable", "unavailable"],
    ["retry_pending", "retry automatically"],
    ["index_failed", "could not be published"],
  ])("maps %s to a safe actionable message", (reason, message) => {
    render(<KnowledgeStatus file={file({ status: "failed", reason })} />);
    expect(screen.getByRole("alert")).toHaveTextContent(message);
  });

  it("does not show unknown vendor details as success or raw text", () => {
    render(
      <KnowledgeStatus file={file({ status: "refused", reason: "VENDOR_PRIVATE_DOCUMENT" })} />
    );
    expect(screen.getByRole("alert")).toHaveTextContent("unknown processing error");
    expect(screen.queryByText(/VENDOR_PRIVATE_DOCUMENT/)).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Previous Knowledge result");
  });

  it.each([
    { canManage: false },
    { archivedAt: "2026-09-19T00:00:00.000Z" },
    { currentVersionId: "new_version" },
  ])("hides receipts that no longer apply: %j", (overrides) => {
    const { container } = render(<KnowledgeStatus file={file({}, overrides)} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("discloses partial publication", () => {
    render(<KnowledgeStatus file={file({ status: "succeeded", truncated: true })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Only part of this document was indexed");
  });
});

describe("Knowledge polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(fetchFile).mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("loads authorized metadata and stops once the receipt is completed", async () => {
    const completed = file({ status: "succeeded" });
    vi.mocked(fetchFile).mockResolvedValue(completed);
    const onFile = vi.fn();
    const onError = vi.fn();
    const { rerender } = renderHook(
      ({ current }) => useKnowledgePolling([current], onFile, onError),
      { initialProps: { current: file() } }
    );
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(fetchFile).toHaveBeenCalledWith("file_1", expect.any(AbortSignal));
    expect(onFile).toHaveBeenCalledWith(completed);
    rerender({ current: completed });
    await act(() => vi.advanceTimersByTimeAsync(6000));
    expect(fetchFile).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it.each(["unmount", "scope", "pause"] as const)(
    "cancels the request and ignores its stale result after %s",
    async (change) => {
      let resolve: (value: LibraryFile) => void = () => {};
      vi.mocked(fetchFile).mockReturnValue(
        new Promise((done) => {
          resolve = done;
        })
      );
      const onFile = vi.fn();
      const onError = vi.fn();
      const { result, rerender, unmount } = renderHook(
        ({ scope, paused }) => useKnowledgePolling([file()], onFile, onError, paused, scope),
        { initialProps: { scope: "all", paused: false } }
      );
      await act(() => vi.advanceTimersByTimeAsync(2000));
      const signal = vi.mocked(fetchFile).mock.calls[0]?.[1];
      if (change === "unmount") unmount();
      else if (change === "scope") rerender({ scope: "mine", paused: false });
      else {
        act(() => result.current());
        rerender({ scope: "all", paused: true });
      }
      expect(signal?.aborted).toBe(true);
      await act(async () => resolve(file({ status: "succeeded" })));
      expect(onFile).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    }
  );

  it("reports fetch errors explicitly without exposing server details or continuing to poll", async () => {
    vi.mocked(fetchFile).mockRejectedValue(new Error("PRIVATE_VENDOR_MESSAGE"));
    const onFile = vi.fn();
    const onError = vi.fn();
    renderHook(() => useKnowledgePolling([file()], onFile, onError));
    await act(() => vi.advanceTimersByTimeAsync(6000));
    expect(fetchFile).toHaveBeenCalledTimes(1);
    expect(onFile).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("Reload the page"));
    expect(onError).not.toHaveBeenCalledWith(expect.stringContaining("PRIVATE_VENDOR_MESSAGE"));
  });
});
