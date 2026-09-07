import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchFileObjectUrl = vi.fn();

vi.mock("~/lib/files", async (importOriginal) => {
  const original = await importOriginal<typeof import("~/lib/files")>();
  return {
    ...original,
    fetchFileObjectUrl: (...args: unknown[]) => fetchFileObjectUrl(...args),
  };
});

const { UploadFailed } = await import("~/lib/files");
const { DownloadButton } = await import("./file-preview");

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
