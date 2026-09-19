import { describe, expect, it } from "vitest";
import { synthesizeAttachment } from "./case.ts";
import {
  observePdfInputs,
  observeProviderPromptFiles,
  observeProviderPromptText,
} from "./provider-prompt.ts";
import { type Observation, scoreCase } from "./scorer.ts";

const base: Observation = {
  systemPrompt: "",
  toolCalls: [],
  output: { kind: "text", text: "done" },
  status: "completed",
  guardrails: [],
};

describe("provider-facing File observations", () => {
  it("observes actual PDF pages and production accounting rather than fixture-declared dimensions", () => {
    const pdf = synthesizeAttachment({
      fileId: "scan",
      name: "scan.pdf",
      mediaType: "application/pdf",
      pdf: { variant: "scan" },
    });
    expect(
      observePdfInputs([
        {
          ...pdf,
          visual: {
            kind: "pdf",
            pages: [
              { width: 1224, height: 1584 },
              { width: 840, height: 1188 },
            ],
          },
        },
      ])
    ).toEqual([
      {
        fileId: "scan",
        pages: [
          { width: 1224, height: 1584 },
          { width: 840, height: 1188 },
        ],
        textPresent: false,
        estimatedTokens: 3917,
      },
    ]);
    expect(observePdfInputs([pdf])).toEqual([
      {
        fileId: "scan",
        textPresent: false,
        estimatedTokens: Number.POSITIVE_INFINITY,
      },
    ]);
  });
  it("reads projected text, not binary bytes or assistant-authored prose", () => {
    const providerPromptText = observeProviderPromptText([
      { role: "user", content: [{ type: "text", text: "Extracted policy: 73 days." }] },
      { role: "assistant", content: "Invented policy: 90 days." },
      { role: "user", content: [{ type: "file", data: Buffer.from("Secret binary fact.") }] },
    ]);
    const results = scoreCase(
      [
        { kind: "provider_prompt_contains", text: "73 days" },
        { kind: "provider_prompt_contains", text: "90 days" },
        { kind: "provider_prompt_contains", text: "Secret binary fact" },
      ],
      { ...base, providerPromptText }
    );
    expect(results.map((result) => result.passed)).toEqual([true, false, false]);
    expect(
      scoreCase([{ kind: "provider_prompt_contains", text: "73 days" }], {
        ...base,
        output: { kind: "text", text: "73 days" },
      })[0]?.passed
    ).toBe(false);
  });

  const revoked = synthesizeAttachment({
    fileId: "file-revoked",
    mediaType: "application/pdf",
    name: "revoked.pdf",
    content: "revoked",
  });

  it("fails confinement when a converter leaks a declared File absent from runtime attachments", () => {
    const providerPromptFiles = observeProviderPromptFiles(
      [
        {
          content: [
            {
              type: "file",
              data: revoked.data,
              mediaType: revoked.mediaType,
              filename: revoked.name,
            },
          ],
        },
      ],
      [revoked]
    );

    const [result] = scoreCase([{ kind: "provider_prompt_omits_file", fileId: revoked.fileId }], {
      ...base,
      providerPromptFiles,
    });
    expect(result?.passed).toBe(false);
  });

  it("fails exactness when upstream bytes changed before provider conversion", () => {
    const providerPromptFiles = observeProviderPromptFiles(
      [
        {
          content: [
            {
              type: "file",
              data: new Uint8Array([1, 2, 3]),
              mediaType: revoked.mediaType,
              filename: revoked.name,
            },
          ],
        },
      ],
      [revoked]
    );

    const [result] = scoreCase(
      [{ kind: "provider_prompt_file_exact", fileId: revoked.fileId, part: "file" }],
      { ...base, providerPromptFiles }
    );
    expect(result?.passed).toBe(false);
    expect(result?.detail).toContain("changed");
  });

  it("fails confinement when a native binary part cannot be attributed", () => {
    const providerPromptFiles = observeProviderPromptFiles(
      [
        {
          content: [
            {
              type: "file",
              data: new Uint8Array([9, 9, 9]),
              mediaType: "application/octet-stream",
              filename: "unknown.bin",
            },
          ],
        },
      ],
      [revoked]
    );

    const [result] = scoreCase([{ kind: "provider_prompt_omits_file", fileId: revoked.fileId }], {
      ...base,
      providerPromptFiles,
    });
    expect(result?.passed).toBe(false);
    expect(result?.detail).toContain("could not be attributed");
  });

  it("fails confinement closed for an unsupported native data representation", () => {
    const providerPromptFiles = observeProviderPromptFiles(
      [
        {
          content: [
            {
              type: "file",
              data: "https://files.invalid/revoked.pdf",
              mediaType: revoked.mediaType,
              filename: revoked.name,
            },
          ],
        },
      ],
      [revoked]
    );

    const [result] = scoreCase([{ kind: "provider_prompt_omits_file", fileId: revoked.fileId }], {
      ...base,
      providerPromptFiles,
    });
    expect(result?.passed).toBe(false);
    expect(result?.detail).toContain("could not be attributed");
  });

  it("attributes repeated authorized parts without weakening revoked-File confinement", () => {
    const allowed = synthesizeAttachment({
      fileId: "file-allowed",
      mediaType: "application/pdf",
      name: "allowed.pdf",
      content: "allowed",
    });
    const repeated = {
      type: "file",
      data: allowed.data,
      mediaType: allowed.mediaType,
      filename: allowed.name,
    };
    const providerPromptFiles = observeProviderPromptFiles(
      [{ content: [repeated] }, { content: [repeated] }],
      [allowed, revoked]
    );

    expect(providerPromptFiles.map((file) => file.fileId)).toEqual([
      allowed.fileId,
      allowed.fileId,
    ]);
    const [result] = scoreCase([{ kind: "provider_prompt_omits_file", fileId: revoked.fileId }], {
      ...base,
      providerPromptFiles,
    });
    expect(result?.passed).toBe(true);
  });
});
