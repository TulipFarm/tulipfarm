import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReportBugModal } from "~/components/report-bug-modal";
import * as clipboard from "~/lib/clipboard";
import * as reportBug from "~/lib/report-bug";

vi.mock("~/lib/clipboard", () => ({
  copyImageBlob: vi.fn(),
}));
const copyImageBlob = vi.mocked(clipboard.copyImageBlob);

vi.mock("~/lib/report-bug", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/report-bug")>();
  return {
    ...actual,
    downloadBlob: vi.fn(),
  };
});
const downloadBlob = vi.mocked(reportBug.downloadBlob);

const mockScreenshot = {
  blob: new Blob(["fake-image"], { type: "image/png" }),
  dataUrl: "data:image/png;base64,fake-data",
};

describe("ReportBugModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders when open with screenshot preview and form inputs", () => {
    render(<ReportBugModal open={true} onClose={vi.fn()} screenshot={mockScreenshot} />);

    expect(screen.getByRole("heading", { name: "Report a bug" })).toBeInTheDocument();
    expect(screen.getByAltText("Captured screen preview")).toHaveAttribute(
      "src",
      "data:image/png;base64,fake-data"
    );
    expect(screen.getByLabelText("Title")).toBeInTheDocument();
    expect(screen.getByLabelText("Description")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Copy screenshot/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Download PNG/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open GitHub issue/i })).toBeInTheDocument();
  });

  it("handles copy screenshot feedback", async () => {
    const user = userEvent.setup();
    copyImageBlob.mockResolvedValue(true);

    render(<ReportBugModal open={true} onClose={vi.fn()} screenshot={mockScreenshot} />);

    const copyBtn = screen.getByRole("button", { name: /Copy screenshot/i });
    await user.click(copyBtn);

    expect(copyImageBlob).toHaveBeenCalledWith(mockScreenshot.blob);
    expect(screen.getByText("Copied to clipboard")).toBeInTheDocument();
  });

  it("handles download screenshot", async () => {
    const user = userEvent.setup();
    render(<ReportBugModal open={true} onClose={vi.fn()} screenshot={mockScreenshot} />);

    const downloadBtn = screen.getByRole("button", { name: /Download PNG/i });
    await user.click(downloadBtn);

    expect(downloadBlob).toHaveBeenCalledWith(mockScreenshot.blob);
  });

  it("opens GitHub issue with user entered title and description", async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const onClose = vi.fn();

    render(<ReportBugModal open={true} onClose={onClose} screenshot={mockScreenshot} />);

    await user.type(screen.getByLabelText("Title"), "Broken button");
    await user.type(screen.getByLabelText("Description"), "Clicked and nothing happened");

    await user.click(screen.getByRole("button", { name: /Open GitHub issue/i }));

    expect(openSpy).toHaveBeenCalledTimes(1);
    const openedUrl = new URL(openSpy.mock.calls[0][0] as string);
    expect(openedUrl.searchParams.get("title")).toBe("Broken button");
    expect(openedUrl.searchParams.get("body")).toContain("Clicked and nothing happened");
    expect(openedUrl.searchParams.get("labels")).toBe("bug");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders notice when screenshot is null", () => {
    render(<ReportBugModal open={true} onClose={vi.fn()} screenshot={null} />);

    expect(screen.getByText(/Screenshot not attached/i)).toBeInTheDocument();
  });
});
