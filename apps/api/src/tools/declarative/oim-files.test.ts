import type { FileService } from "@tulipfarm/files";
import { describe, expect, it, vi } from "vitest";
import { oimFiles } from "./oim-files";

describe("oimFiles", () => {
  it("uses FileService for both OIM byte paths", async () => {
    const body = (async function* () {
      yield new Uint8Array([1, 2, 3]);
    })();
    const files = {
      content: vi.fn(async () => ({
        file: { id: "file-1", filename: "input.pdf", mediaType: "application/pdf", sizeBytes: 3 },
        body,
      })),
      upload: vi.fn(async () => ({
        id: "file-2",
        filename: "output.pdf",
        mediaType: "application/pdf",
        sizeBytes: 3,
      })),
    } as unknown as FileService;
    const port = oimFiles(files);

    await expect(
      port.content({ businessId: "business-1", fileId: "file-1", principalId: "user-1" })
    ).resolves.toMatchObject({ file: { id: "file-1" } });
    await expect(
      port.store({
        businessId: "business-1",
        ownerPrincipalId: "user-1",
        filename: "output.pdf",
        claimedMediaType: "application/pdf",
        declaredBytes: 3,
        body,
      })
    ).resolves.toMatchObject({ id: "file-2" });

    expect(files.content).toHaveBeenCalledWith("business-1", "file-1", "user-1");
    expect(files.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "business-1",
        ownerPrincipalId: "user-1",
        claimedMediaType: "application/pdf",
      })
    );
  });
});
