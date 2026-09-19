import { createServer } from "node:http";
import { type Format, toMarkdownBytes } from "@firecrawl/anydoc";
import { getDocumentProxy } from "unpdf";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractText, MAX_EXTRACTED_CHARS } from "./extract";
import { MAX_FILE_BYTES } from "./limits";
import { externalPdf } from "./pdf-fixture.test-support";

afterEach(() => vi.unstubAllEnvs());

describe("local PDF conversion", () => {
  it("reads independent PDF text and retains exact source bytes and dimensions", async () => {
    const bytes = externalPdf("text");
    const original = bytes.slice();
    const result = await extractText("application/pdf", bytes);
    expect(bytes).toEqual(original);
    expect(result).toMatchObject({
      kind: "text",
      text: expect.stringContaining("The warranty lasts 47 days."),
      truncated: false,
      visual: { kind: "pdf", pages: [{ width: 1224, height: 1584 }] },
    });
  });

  it("preserves the converter's Markdown, including code and table whitespace", async () => {
    const bytes = externalPdf("layout");
    const markdown = await toMarkdownBytes(bytes.slice(), "pdf" as Format, { ocr: "reject" });
    const result = await extractText("application/pdf", bytes);
    expect(result).toMatchObject({ kind: "text", text: markdown, truncated: false });
    expect(markdown).toContain("Approval handbook");
    expect(markdown).toContain("publish");
    expect(markdown).toContain("Pune");
    expect(markdown).toContain("731");
  });

  it.each(["scan", "mixed"] as const)(
    "refuses all %s text while retaining original binary and every page",
    async (variant) => {
      const bytes = externalPdf(
        variant,
        "Visible first-page fact must not become partial success."
      );
      const original = bytes.slice();
      await expect(
        toMarkdownBytes(bytes.slice(), "pdf" as Format, { ocr: "reject" })
      ).rejects.toMatchObject({
        code: "needsOcr",
      });
      const result = await extractText("application/pdf", bytes);
      expect(result).toEqual({
        kind: "refused",
        reason: "needs_ocr",
        visual: {
          kind: "pdf",
          pages:
            variant === "scan"
              ? [{ width: 1224, height: 1584 }]
              : [
                  { width: 1224, height: 1584 },
                  { width: 840, height: 1188 },
                ],
        },
      });
      expect(result).not.toHaveProperty("text");
      expect(bytes).toEqual(original);
    }
  );

  it("distinguishes actual password encryption from malformed content", async () => {
    const encrypted = externalPdf("encrypted");
    await expect(getDocumentProxy(encrypted.slice(), { verbosity: 0 })).rejects.toMatchObject({
      name: "PasswordException",
    });
    const unlocked = await getDocumentProxy(encrypted.slice(), {
      password: "fixture-reader",
      verbosity: 0,
    });
    expect(unlocked.numPages).toBe(1);
    await unlocked.loadingTask.destroy();
    await expect(extractText("application/pdf", encrypted)).resolves.toEqual({
      kind: "refused",
      reason: "encrypted",
    });
    await expect(extractText("application/pdf", externalPdf("malformed"))).resolves.toEqual({
      kind: "refused",
      reason: "unreadable",
    });
  });

  it("caps converted output, not input bytes, at exact character boundaries", async () => {
    const bytes = externalPdf();
    const markdown = await toMarkdownBytes(bytes.slice(), "pdf" as Format, { ocr: "reject" });
    for (const cap of [0, markdown.length - 1, markdown.length, markdown.length + 1]) {
      await expect(extractText("application/pdf", bytes, { maxChars: cap })).resolves.toMatchObject(
        {
          kind: "text",
          text: markdown.slice(0, cap),
          truncated: markdown.length > cap,
        }
      );
    }
    const long = await extractText(
      "application/pdf",
      externalPdf("text", "alpha ".repeat(Math.ceil(MAX_EXTRACTED_CHARS / 6) + 100))
    );
    expect(long).toMatchObject({ kind: "text", truncated: true });
    if (long.kind === "text") expect(long.text).toHaveLength(MAX_EXTRACTED_CHARS);
    await expect(
      extractText("application/pdf", new Uint8Array(MAX_FILE_BYTES + 1))
    ).resolves.toEqual({
      kind: "refused",
      reason: "resource_limit",
    });
  });

  it("honors cancellation as infrastructure, not document refusal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      extractText("application/pdf", externalPdf(), { signal: controller.signal })
    ).rejects.toMatchObject({ name: "DocumentConversionError", code: "cancelled" });
  });

  it("never contacts hosted OCR even with credentials and an endpoint in the environment", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(500).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Missing test endpoint");
      vi.stubEnv("FIRECRAWL_API_KEY", "synthetic-not-a-credential");
      vi.stubEnv("FIRECRAWL_API_URL", `http://127.0.0.1:${address.port}`);
      for (const variant of ["scan", "mixed"] as const) {
        await expect(extractText("application/pdf", externalPdf(variant))).resolves.toMatchObject({
          kind: "refused",
          reason: "needs_ocr",
        });
      }
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
