import { DocumentConversionError, extractText } from "@tulipfarm/files";
import { externalPdf } from "@tulipfarm/files/test-fixtures/pdf";
import { splitPrompt } from "@tulipfarm/model-adapter";
import { describe, expect, it } from "vitest";
import { InternalApiClient } from "./client";
import { HttpTurnHost } from "./turn-host";

const host = new HttpTurnHost(
  new InternalApiClient({
    baseUrl: "http://control-plane.invalid",
    credential: "tfc_test.synthetic",
    fetch: async () => {
      throw new Error("Unexpected HTTP request");
    },
  })
);

describe("PDF attachment classification", () => {
  it.each(["text", "scan", "mixed"] as const)(
    "delivers original %s PDF bytes through the actual provider projection",
    async (variant) => {
      const bytes = externalPdf(variant);
      const before = bytes.slice();
      const extracted = await extractText("application/pdf", bytes);
      const file = {
        fileId: "pdf",
        name: "policy.pdf",
        mediaType: "application/pdf",
        data: bytes,
        ...(extracted.kind === "text" ? { text: extracted.text } : {}),
        visual: extracted.visual,
      };
      const projected = splitPrompt(
        [
          {
            role: "user",
            content: [
              { type: "file", fileId: file.fileId, mediaType: file.mediaType, name: file.name },
            ],
          },
        ],
        [file]
      );
      expect(projected.messages).toEqual([
        {
          role: "user",
          content: [{ type: "file", data: before, mediaType: file.mediaType, filename: file.name }],
        },
      ]);
      expect(bytes).toEqual(before);
    }
  );
  it.each(["scan", "mixed"] as const)(
    "keeps a readable %s PDF available to vision without partial guard text",
    async (variant) => {
      const bytes = externalPdf(variant);
      const before = bytes.slice();
      const result = await host.inspect("application/pdf", bytes);
      expect(result).not.toHaveProperty("refusal");
      expect(result).not.toHaveProperty("text");
      expect(result.visual).toEqual({
        kind: "pdf",
        pages:
          variant === "scan"
            ? [{ width: 1224, height: 1584 }]
            : [
                { width: 1224, height: 1584 },
                { width: 840, height: 1188 },
              ],
      });
      expect(bytes).toEqual(before);
    }
  );

  it.each([
    ["malformed", "unreadable"],
    ["encrypted", "encrypted"],
  ] as const)("does not accept %s PDF bytes as a visual attachment", async (variant, reason) => {
    const bytes = externalPdf(variant);
    await expect(host.inspect("application/pdf", bytes)).resolves.toEqual({ refusal: reason });
    await expect(host.extract("application/pdf", bytes)).rejects.toMatchObject({
      name: "DocumentRefusedError",
      reason,
    });
  });

  it("screens AnyDoc text and keeps operational cancellation distinct", async () => {
    await expect(host.inspect("application/pdf", externalPdf())).resolves.toMatchObject({
      text: expect.stringContaining("47 days"),
      visual: { kind: "pdf", pages: [{ width: 1224, height: 1584 }] },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      host.inspect("application/pdf", externalPdf(), controller.signal)
    ).rejects.toBeInstanceOf(DocumentConversionError);
  });
});
