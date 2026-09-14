import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { FilePickerModal } from "./file-picker-modal";

const searchFiles = vi.fn();

vi.mock("~/lib/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/files")>()),
  searchFiles: (...args: unknown[]) => searchFiles(...(args as [])),
}));

const file = {
  id: "file-1",
  filename: "report.pdf",
  mediaType: "application/pdf",
  sizeBytes: 2048,
  createdAt: "2024-01-01T00:00:00.000Z",
};

beforeEach(() => {
  searchFiles.mockReset();
  searchFiles.mockResolvedValue([file]);
});

it("opens on the Workspace Files tab by default", () => {
  render(
    <FilePickerModal
      open
      onClose={vi.fn()}
      onAttachExisting={vi.fn()}
      onFilesDropped={vi.fn()}
      onBrowse={vi.fn()}
    />
  );
  expect(screen.getByRole("tab", { name: "Workspace Files" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  expect(screen.getByText("Start typing to search your workspace files.")).toBeTruthy();
});

it("switches to the Upload tab and offers a drop zone that opens the OS picker", async () => {
  const user = userEvent.setup();
  const onBrowse = vi.fn();
  render(
    <FilePickerModal
      open
      onClose={vi.fn()}
      onAttachExisting={vi.fn()}
      onFilesDropped={vi.fn()}
      onBrowse={onBrowse}
    />
  );

  await user.click(screen.getByRole("tab", { name: "Upload" }));
  await user.click(screen.getByRole("button", { name: /Drag and drop files/ }));

  expect(onBrowse).toHaveBeenCalledOnce();
});

it("switches to the Cloud Integrations tab and shows a coming-soon placeholder", async () => {
  const user = userEvent.setup();
  render(
    <FilePickerModal
      open
      onClose={vi.fn()}
      onAttachExisting={vi.fn()}
      onFilesDropped={vi.fn()}
      onBrowse={vi.fn()}
    />
  );

  await user.click(screen.getByRole("tab", { name: /Cloud Integrations/ }));

  expect(screen.getAllByText("Coming soon").length).toBeGreaterThan(0);
  expect(screen.getByText(/Attaching files straight from Google Drive/)).toBeTruthy();
});

it("searching Workspace Files and choosing a result attaches it and closes", async () => {
  const user = userEvent.setup();
  const onAttachExisting = vi.fn();
  const onClose = vi.fn();
  render(
    <FilePickerModal
      open
      onClose={onClose}
      onAttachExisting={onAttachExisting}
      onFilesDropped={vi.fn()}
      onBrowse={vi.fn()}
    />
  );

  await user.type(screen.getByLabelText("Search workspace files"), "report");
  await waitFor(() => expect(searchFiles).toHaveBeenCalledWith("report", 20, expect.anything()));
  await user.click(await screen.findByText("report.pdf"));

  expect(onAttachExisting).toHaveBeenCalledWith(file);
  expect(onClose).toHaveBeenCalledOnce();
});
