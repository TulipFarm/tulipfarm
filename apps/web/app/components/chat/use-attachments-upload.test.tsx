import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useAttachments } from "./use-attachments";

const uploadFile = vi.fn((..._args: unknown[]) => ({
  done: new Promise(() => {}),
  cancel: () => {},
}));

vi.mock("~/lib/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/files")>()),
  fetchAcceptedModalities: vi.fn(async () => ["text", "image", "document"]),
  uploadFile: (...args: unknown[]) => uploadFile(...args),
}));

function fileOf(name: string, type: string): File {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: 32 });
  return file;
}

describe("uploading an attached File", () => {
  it("sends one File's bytes exactly once", () => {
    // The regression this guards: `uploadFile` used to be called from inside the `setAttachments`
    // updater, and React may invoke an updater more than once for a single state change. Every
    // chat upload was stored twice, so the Files page showed two copies of one document.
    // `StrictMode` reproduces that second invocation deterministically.
    const { result } = renderHook(() => useAttachments(), { wrapper: StrictMode });

    act(() => result.current.add([fileOf("orders.csv", "text/csv")]));

    expect(uploadFile).toHaveBeenCalledTimes(1);
  });

  it("still stages exactly one chip for that File", () => {
    uploadFile.mockClear();
    const { result } = renderHook(() => useAttachments(), { wrapper: StrictMode });

    act(() => result.current.add([fileOf("orders.csv", "text/csv")]));

    expect(result.current.attachments).toHaveLength(1);
  });
});
