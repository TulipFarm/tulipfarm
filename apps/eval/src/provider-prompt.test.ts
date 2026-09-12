import { describe, expect, it } from "vitest";
import { synthesizeAttachment } from "./case.ts";
import { observeProviderPromptFiles } from "./provider-prompt.ts";
import { type Observation, scoreCase } from "./scorer.ts";

const base: Observation = {
  systemPrompt: "",
  toolCalls: [],
  output: { kind: "text", text: "done" },
  status: "completed",
  guardrails: [],
};

describe("provider-facing File observations", () => {
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
