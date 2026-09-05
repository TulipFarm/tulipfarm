import { describe, expect, it } from "vitest";
import { isAttachmentRefusal, resolveAttachments } from "./attachments";
import type { FileRecord } from "./repo";
import { FileError, type FileService } from "./service";

function fileService(readable: Record<string, Partial<FileRecord>>): FileService {
  return {
    readForAttachment: async (_businessId: string, id: string) => {
      const found = readable[id];
      if (!found || found.archivedAt) throw new FileError("not_found", "no such file");
      return { id, filename: "a.png", mediaType: "image/png", ...found } as FileRecord;
    },
  } as unknown as FileService;
}

describe("resolveAttachments", () => {
  it("returns no parts when nothing is attached", async () => {
    const result = await resolveAttachments(fileService({}), "b", "p", undefined);
    expect(result).toEqual([]);
  });

  it("turns each id into a file part carrying the stored type, not a claimed one", async () => {
    const files = fileService({ f1: { mediaType: "image/png", filename: "shot.png" } });
    const result = await resolveAttachments(files, "b", "p", ["f1"]);
    expect(result).toEqual([
      { type: "file", fileId: "f1", mediaType: "image/png", name: "shot.png" },
    ]);
  });

  it("refuses the whole message when one id does not resolve", async () => {
    const result = await resolveAttachments(fileService({ f1: {} }), "b", "p", ["f1", "missing"]);
    expect(isAttachmentRefusal(result)).toBe(true);
    expect(isAttachmentRefusal(result) && result.status).toBe(404);
  });

  it("refuses an archived File as a new attachment", async () => {
    const result = await resolveAttachments(
      fileService({ f1: { archivedAt: new Date() } }),
      "b",
      "p",
      ["f1"]
    );
    expect(isAttachmentRefusal(result) && result.status).toBe(404);
  });

  it("refuses rather than silently truncating past the per-message limit", async () => {
    const ids = Array.from({ length: 11 }, (_, index) => `f${index}`);
    const result = await resolveAttachments(fileService({}), "b", "p", ids);
    expect(isAttachmentRefusal(result) && result.status).toBe(400);
  });

  it("refuses when the instance has no file storage configured", async () => {
    const result = await resolveAttachments(undefined, "b", "p", ["f1"]);
    expect(isAttachmentRefusal(result) && result.status).toBe(503);
  });

  it("propagates a non-FileError, because that is a fault and not a refusal", async () => {
    const broken = {
      readForAttachment: async () => {
        throw new Error("database is down");
      },
    } as unknown as FileService;
    await expect(resolveAttachments(broken, "b", "p", ["f1"])).rejects.toThrow("database is down");
  });
});
