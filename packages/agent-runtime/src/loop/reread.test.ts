import { describe, expect, it } from "vitest";
import { extractRereadFile, MAX_REREAD_FILES, mergeAttachments, rememberReread } from "./reread";

const file = (fileId: string) => ({ fileId, mediaType: "application/pdf", name: `${fileId}.pdf` });
const resolved = (fileId: string) => ({ ...file(fileId), data: new Uint8Array([1]) });

describe("extractRereadFile", () => {
  it("takes the File a read asked to be shown", () => {
    expect(
      extractRereadFile({
        fileId: "file-1",
        mediaType: "image/png",
        filename: "receipt.png",
        attached: true,
      })
    ).toEqual({ fileId: "file-1", mediaType: "image/png", name: "receipt.png" });
  });

  it("ignores a text read, whose content already came back as characters", () => {
    expect(
      extractRereadFile({ fileId: "file-1", mediaType: "text/plain", kind: "text", text: "hi" })
    ).toBeUndefined();
  });

  it("ignores anything that is not a well-formed request to attach", () => {
    // The output is a Tool's word, and a Tool is the far side of a dispatch. Nothing here may be
    // assumed: a missing id or type would otherwise become an attachment naming nothing.
    expect(extractRereadFile(undefined)).toBeUndefined();
    expect(extractRereadFile("attached")).toBeUndefined();
    expect(extractRereadFile({ attached: true })).toBeUndefined();
    expect(extractRereadFile({ attached: true, fileId: "file-1" })).toBeUndefined();
    expect(
      extractRereadFile({ attached: true, fileId: "", mediaType: "image/png" })
    ).toBeUndefined();
    expect(
      extractRereadFile({ attached: "yes", fileId: "f", mediaType: "image/png" })
    ).toBeUndefined();
  });

  it("falls back to the id when a Tool names no filename", () => {
    expect(extractRereadFile({ attached: true, fileId: "file-1", mediaType: "image/png" })).toEqual(
      {
        fileId: "file-1",
        mediaType: "image/png",
        name: "file-1",
      }
    );
  });
});

describe("rememberReread", () => {
  it("keeps a File once however many times it is read", () => {
    const once = rememberReread([], file("file-1"));
    expect(rememberReread(once, file("file-1")).map((f) => f.fileId)).toEqual(["file-1"]);
  });

  it("drops the oldest rather than refusing the newest past the cap", () => {
    // Every held File is re-sent on every remaining step, so the set has to be bounded. Refusing
    // the File the model just asked for is the confusing half of that trade; forgetting the one it
    // stopped talking about is not.
    let held: readonly ReturnType<typeof file>[] = [];
    for (let index = 0; index < MAX_REREAD_FILES + 2; index += 1) {
      held = rememberReread(held, file(`file-${index}`));
    }
    expect(held).toHaveLength(MAX_REREAD_FILES);
    expect(held.map((f) => f.fileId)).toEqual(["file-2", "file-3", "file-4", "file-5"]);
  });

  it("treats a re-read as recent, so it is not the next one dropped", () => {
    let held: readonly ReturnType<typeof file>[] = [];
    for (let index = 0; index < MAX_REREAD_FILES; index += 1) {
      held = rememberReread(held, file(`file-${index}`));
    }
    held = rememberReread(held, file("file-0"));
    held = rememberReread(held, file("file-new"));
    expect(held.map((f) => f.fileId)).toEqual(["file-2", "file-3", "file-0", "file-new"]);
  });
});

describe("mergeAttachments", () => {
  it("sends a File once when it was both attached and re-read", () => {
    expect(
      mergeAttachments([resolved("file-1")], [resolved("file-1")]).map((f) => f.fileId)
    ).toEqual(["file-1"]);
  });

  it("keeps the Turn's own attachments first", () => {
    expect(
      mergeAttachments([resolved("file-1")], [resolved("file-2")]).map((f) => f.fileId)
    ).toEqual(["file-1", "file-2"]);
  });
});
