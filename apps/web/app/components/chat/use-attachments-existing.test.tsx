import { act, renderHook } from "@testing-library/react";
import { MAX_FILES_PER_MESSAGE } from "@tulipfarm/files";
import { describe, expect, it, vi } from "vitest";
import { useAttachments } from "./use-attachments";

const uploadFile = vi.fn();

vi.mock("~/lib/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/files")>()),
  fetchAcceptedModalities: vi.fn(async () => ["text", "image", "document"]),
  uploadFile: (...args: unknown[]) => uploadFile(...args),
}));

function stored(id: string) {
  return {
    id,
    filename: `${id}.pdf`,
    mediaType: "application/pdf",
    sizeBytes: 10,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("staging a File that is already stored", () => {
  it("is ready immediately and sends no bytes", () => {
    const { result } = renderHook(() => useAttachments());

    act(() => result.current.addExisting(stored("file_1")));

    expect(result.current.readyFiles.map((f) => f.fileId)).toEqual(["file_1"]);
    expect(result.current.uploading).toBe(false);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("stages one File once, however many times the library hands it over", () => {
    const { result } = renderHook(() => useAttachments());

    act(() => {
      result.current.addExisting(stored("file_1"));
      result.current.addExisting(stored("file_1"));
    });

    expect(result.current.attachments).toHaveLength(1);
  });

  it("respects the per-message cap that an upload would have hit", () => {
    const { result } = renderHook(() => useAttachments());

    act(() => {
      for (let i = 0; i <= MAX_FILES_PER_MESSAGE; i += 1)
        result.current.addExisting(stored(`f${i}`));
    });

    expect(result.current.attachments).toHaveLength(MAX_FILES_PER_MESSAGE);
  });
});
