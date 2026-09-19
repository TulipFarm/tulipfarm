import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchFileObjectUrl = vi.fn();
const fetchFileBytes = vi.fn();
vi.mock("docx-preview", () => ({
  renderAsync: () => Promise.reject(new Error("Use the semantic preview")),
}));

vi.mock("~/lib/files", async (importOriginal) => {
  const original = await importOriginal<typeof import("~/lib/files")>();
  return {
    ...original,
    fetchFileObjectUrl: (...args: unknown[]) => fetchFileObjectUrl(...args),
    fetchFileBytes: (...args: unknown[]) => fetchFileBytes(...args),
  };
});

const { UploadFailed } = await import("~/lib/files");
const { DownloadButton, FilePreview } = await import("./file-preview");

class LocalWorker {
  static instances: LocalWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    LocalWorker.instances.push(this);
  }
}

describe("FilePreview", () => {
  const word = {
    id: "word",
    filename: "word.docx",
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };

  beforeEach(() => {
    LocalWorker.instances = [];
    vi.stubGlobal("Worker", LocalWorker);
    fetchFileBytes.mockReset();
    fetchFileBytes.mockResolvedValue({
      bytes: new Uint8Array([80, 75, 3, 4]),
      text: () => "",
    });
    fetchFileObjectUrl.mockReset();
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("terminates the Word worker when the modal closes", async () => {
    const { rerender } = render(<FilePreview file={word} onClose={() => {}} />);
    await screen.findByText("Reading Word document locally…");
    const worker = LocalWorker.instances[0];
    expect(worker).toBeDefined();
    rerender(<FilePreview file={null} onClose={() => {}} />);
    expect(worker?.terminate).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("terminates on unmount and on selected File changes, leaving PDF preview intact", async () => {
    const { rerender, unmount } = render(<FilePreview file={word} onClose={() => {}} />);
    await screen.findByText("Reading Word document locally…");
    const worker = LocalWorker.instances[0];
    fetchFileObjectUrl.mockResolvedValue("blob:pdf-preview");
    rerender(
      <FilePreview
        file={{ id: "pdf", filename: "report.pdf", mediaType: "application/pdf" }}
        onClose={() => {}}
      />
    );
    expect(worker?.terminate).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(document.querySelector("iframe")).toHaveAttribute("src", "blob:pdf-preview")
    );
    rerender(<FilePreview file={word} onClose={() => {}} />);
    await screen.findByText("Reading Word document locally…");
    const next = LocalWorker.instances[1];
    unmount();
    expect(next?.terminate).toHaveBeenCalledOnce();
  });
});

describe("DownloadButton", () => {
  beforeEach(() => {
    fetchFileObjectUrl.mockReset();
    URL.createObjectURL = vi.fn(() => "blob:mock-url");
    URL.revokeObjectURL = vi.fn();
  });

  it("surfaces the failure reason instead of silently returning to idle", async () => {
    const user = userEvent.setup();
    fetchFileObjectUrl.mockRejectedValue(new UploadFailed(500, "That file could not be loaded."));
    render(<DownloadButton fileId="file_1" filename="report.pdf" />);

    await user.click(screen.getByRole("button", { name: "Download" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That file could not be loaded.");
    expect(screen.getByRole("button", { name: "Download failed" })).toBeDisabled();
  });

  it("confirms a successful download rather than dimming and returning to idle", async () => {
    const user = userEvent.setup();
    fetchFileObjectUrl.mockResolvedValue("blob:mock-url");
    render(<DownloadButton fileId="file_1" filename="report.pdf" />);

    await user.click(screen.getByRole("button", { name: "Download" }));

    expect(await screen.findByRole("button", { name: "Downloaded" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
