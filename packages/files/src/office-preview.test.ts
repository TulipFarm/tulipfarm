import { describe, expect, it } from "vitest";
import { DOCX_MEDIA_TYPE, PPTX_MEDIA_TYPE, XLSX_MEDIA_TYPE } from "./document-preview";
import { isOfficePreviewable } from "./office-preview";

describe("Office preview format gate", () => {
  it.each([DOCX_MEDIA_TYPE, XLSX_MEDIA_TYPE, PPTX_MEDIA_TYPE])("accepts %s", (mediaType) => {
    expect(isOfficePreviewable(mediaType)).toBe(true);
  });
  it.each(["application/pdf", "text/csv", "application/vnd.ms-excel"])(
    "rejects %s",
    (mediaType) => {
      expect(isOfficePreviewable(mediaType)).toBe(false);
    }
  );
});
