import { MAX_FILE_BYTES, MAX_FILES_PER_MESSAGE } from "@tulipfarm/files/limits";
import { describe, expect, it } from "vitest";
import { describeRejection } from "./use-attachments";

function fileOf(name: string, type: string, size = 1_024): File {
  const file = new File([""], name, { type });
  // `File` derives size from its parts, and allocating megabytes per case would be wasteful.
  Object.defineProperty(file, "size", { value: size });
  return file;
}

const ANY = ["text", "image", "document"];

describe("describeRejection", () => {
  it("accepts an ordinary image", () => {
    expect(describeRejection(fileOf("shot.png", "image/png"), 0, ANY)).toBeNull();
  });

  it("refuses more files than one message may carry", () => {
    const rejection = describeRejection(fileOf("a.png", "image/png"), MAX_FILES_PER_MESSAGE, ANY);
    expect(rejection).toContain(`${MAX_FILES_PER_MESSAGE} files`);
  });

  it("refuses a file over the size cap, naming it", () => {
    const big = fileOf("huge.png", "image/png", MAX_FILE_BYTES + 1);
    expect(describeRejection(big, 0, ANY)).toContain("huge.png");
  });

  it("refuses an unsupported type", () => {
    expect(describeRejection(fileOf("app.exe", "application/x-msdownload"), 0, ANY)).toContain(
      "not a supported file type"
    );
  });

  describe("when no configured model accepts the modality", () => {
    it("refuses a PDF, names documents, and says what to do instead", () => {
      const rejection = describeRejection(fileOf("report.pdf", "application/pdf"), 0, [
        "text",
        "image",
      ]);

      expect(rejection).toContain("report.pdf");
      expect(rejection).toContain("documents");
      expect(rejection).toContain("paste");
    });

    it("refuses an image, names images, and says what to do instead", () => {
      const rejection = describeRejection(fileOf("chart.png", "image/png"), 0, ["text"]);

      expect(rejection).toContain("chart.png");
      expect(rejection).toContain("images");
      expect(rejection).toContain("describe");
    });

    it("still accepts a file a different configured model can read", () => {
      // The endpoint answers with the union, so a PDF is staged whenever *some* model reads one.
      expect(
        describeRejection(fileOf("report.pdf", "application/pdf"), 0, ["text", "document"])
      ).toBeNull();
    });
  });

  it("stays permissive until the accepted modalities are known", () => {
    // A refusal that fires on a slow or failed capability fetch would be a lie; the server's
    // denial at routing time is the authoritative check either way.
    expect(describeRejection(fileOf("report.pdf", "application/pdf"), 0, undefined)).toBeNull();
  });

  it("never refuses on modality when the browser did not recognise the format", () => {
    // An empty type is left to the server's sniffer, so it must not be judged against a modality.
    expect(describeRejection(fileOf("mystery", "", 10), 0, ["text"])).toBeNull();
  });
});
