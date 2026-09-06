import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FileAttachment } from "./file-attachment";

const fetchFileObjectUrl = vi.fn(async (..._args: unknown[]) => "blob:preview");

vi.mock("~/lib/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/files")>()),
  fetchFileObjectUrl: (...args: unknown[]) => fetchFileObjectUrl(...args),
}));

describe("a document attached to a message", () => {
  it("opens it in the reader rather than downloading it", async () => {
    // Clicking an attachment used to push the bytes straight to the downloads folder, which is a
    // detour: the product already renders these formats in the tab, and a person who wants the
    // file on disk can still say so from inside the reader.
    render(<FileAttachment fileId="file_1" mediaType="application/pdf" name="invoice.pdf" />);

    await userEvent.click(screen.getByRole("button", { name: /invoice\.pdf/i }));

    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("keeps a download reachable from inside the reader", async () => {
    render(<FileAttachment fileId="file_1" mediaType="application/pdf" name="invoice.pdf" />);

    await userEvent.click(screen.getByRole("button", { name: /invoice\.pdf/i }));

    const reader = screen.getByRole("dialog");
    expect(within(reader).getByRole("button", { name: /download/i })).toBeTruthy();
  });
});
