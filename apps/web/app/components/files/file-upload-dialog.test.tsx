import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { FileUploadDialog } from "./file-upload-dialog";

const uploadFile = vi.fn();
const shareFile = vi.fn<() => Promise<void>>();

vi.mock("~/lib/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/files")>()),
  uploadFile: (...args: unknown[]) => uploadFile(...(args as [])),
  shareFile: (...args: unknown[]) => shareFile(...(args as [])),
}));

function textFile(name: string) {
  return new File(["hello"], name, { type: "text/plain" });
}

beforeEach(() => {
  uploadFile.mockReset();
  shareFile.mockReset();
  let next = 0;
  uploadFile.mockImplementation(() => {
    next += 1;
    return { done: Promise.resolve({ id: `file_${next}` }) };
  });
});

it("lists every file picked in one go", async () => {
  render(<FileUploadDialog open onClose={vi.fn()} onUploaded={vi.fn()} />);

  await userEvent.upload(screen.getByTestId("file-picker-input"), [
    textFile("one.txt"),
    textFile("two.txt"),
    textFile("three.txt"),
  ]);

  expect(screen.getByDisplayValue("one.txt")).toBeInTheDocument();
  expect(screen.getByDisplayValue("two.txt")).toBeInTheDocument();
  expect(screen.getByDisplayValue("three.txt")).toBeInTheDocument();
});

it("uploads every picked file, not just the first", async () => {
  const onUploaded = vi.fn();
  const onClose = vi.fn();
  render(<FileUploadDialog open onClose={onClose} onUploaded={onUploaded} />);

  await userEvent.upload(screen.getByTestId("file-picker-input"), [
    textFile("one.txt"),
    textFile("two.txt"),
  ]);
  await userEvent.click(screen.getByRole("button", { name: "Add files" }));

  await waitFor(() => expect(onUploaded).toHaveBeenCalled());
  expect(uploadFile).toHaveBeenCalledTimes(2);
  expect(uploadFile.mock.calls[0]?.[2]).toBe("one.txt");
  expect(uploadFile.mock.calls[1]?.[2]).toBe("two.txt");
  expect(onClose).toHaveBeenCalled();
});

it("keeps the dialog open while the file picker is on screen", async () => {
  const onClose = vi.fn();
  render(<FileUploadDialog open onClose={onClose} onUploaded={vi.fn()} />);
  const dialog = screen.getByRole("dialog", { hidden: true });
  // jsdom reports a zero rect, which would make the backdrop test pass anything.
  dialog.getBoundingClientRect = () =>
    ({ left: 200, right: 600, top: 100, bottom: 400 }) as DOMRect;

  await userEvent.click(screen.getByRole("button", { name: /Drag and drop files/ }));

  expect(onClose).not.toHaveBeenCalled();
});
