import { describe, expect, it } from "vitest";
import { extractOimMultipartFileIds, OimMultipartFileInputError } from "./oim-files";

describe("extractOimMultipartFileIds", () => {
  it("extracts only the fixed composed-MIME attachment input for approval binding", () => {
    expect(
      extractOimMultipartFileIds(
        { mime: { outputPointer: "/message/raw", maxBytes: 1024 } },
        { body: { attachments: ["file-b", "file-a", "file-b"], text: "file-secret" } }
      )
    ).toEqual(["file-a", "file-b"]);
    expect(extractOimMultipartFileIds({}, { body: { attachments: ["file-secret"] } })).toEqual([]);
  });

  it.each(
    [[""], [" file-a"], ["file-a".repeat(30)], [42], "file-a", Array(11).fill("file-a")].map(
      (attachments) => ({ attachments })
    )
  )("rejects malformed composed-MIME attachments %j", ({ attachments }) => {
    expect(() =>
      extractOimMultipartFileIds(
        { mime: { outputPointer: "/raw", maxBytes: 1024 } },
        { body: { attachments } }
      )
    ).toThrow(OimMultipartFileInputError);
  });

  it("extracts only declared File pointers at arbitrary nested JSON paths", () => {
    const binding = {
      multipart: [
        { name: "note", kind: "field" as const, pointer: "/payload/fileId", maxBytes: 64 },
        { name: "first", kind: "file" as const, pointer: "/payload/arbitrary/receipt_blob" },
        { name: "second", kind: "file" as const, pointer: "/uploads/0/source~1file" },
        { name: "duplicate", kind: "file" as const, pointer: "/payload/arbitrary/copy" },
      ],
    };

    expect(
      extractOimMultipartFileIds(binding, {
        body: {
          payload: {
            fileId: "not-a-declared-file",
            arbitrary: { receipt_blob: "file-b", copy: "file-b" },
          },
          uploads: [{ "source/file": "file-a" }],
          guessedFileId: "not-a-declared-file-either",
        },
      })
    ).toEqual(["file-a", "file-b"]);
  });

  it.each([
    ["missing", {}],
    ["wrong type", { nested: { value: 42 } }],
    ["empty", { nested: { value: "" } }],
    ["blank", { nested: { value: "   " } }],
    ["overlong", { nested: { value: "f".repeat(129) } }],
  ])("rejects a %s declared File ID", (_name, body) => {
    expect(() =>
      extractOimMultipartFileIds(
        {
          multipart: [{ name: "upload", kind: "file", pointer: "/nested/value" }],
        },
        { body }
      )
    ).toThrow(OimMultipartFileInputError);
  });
});
