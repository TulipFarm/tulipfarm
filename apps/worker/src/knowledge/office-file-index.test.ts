import { PPTX_MEDIA_TYPE, XLSX_MEDIA_TYPE } from "@tulipfarm/files/document-preview";
import { externalPptx, externalXlsx } from "@tulipfarm/files/test-fixtures/office";
import { describe, expect, it, vi } from "vitest";
import { type FileIndexDeps, handleFileIndexJob } from "./file-index";

const job = {
  fileId: "office-file",
  versionId: "office-version",
  businessId: "biz",
  ownerPrincipalId: "owner",
};

describe("Office Files in opt-in Knowledge", () => {
  it.each([
    [XLSX_MEDIA_TYPE, externalXlsx, "731 tulips"],
    [PPTX_MEDIA_TYPE, externalPptx, "47 days"],
  ] as const)(
    "indexes the real document under live readers (%s)",
    async (mediaType, make, fact) => {
      const bytes = make();
      const readers = [
        { kind: "user" as const, id: "owner" },
        { kind: "role" as const, id: "support" },
      ];
      const ingestSource = vi.fn(async (_input: unknown) => ({ _id: "page-office" }) as never);
      const setPageRestriction = vi.fn(async () => "ok" as const);
      const deps: FileIndexDeps = {
        files: {
          read: async () =>
            ({
              id: job.fileId,
              filename: "office-document",
              mediaType,
              currentVersionId: job.versionId,
              knowledgeRequestedAt: new Date(),
            }) as never,
          knowledgeRequested: async () => true,
          content: async () =>
            ({
              body: (async function* () {
                yield bytes;
              })(),
            }) as never,
          readers: async () => readers,
        },
        knowledge: {
          ingestSource,
          setPageRestriction,
          deletePage: async () => true,
          findSpaceByName: async () => ({ _id: "files-space" }) as never,
          createSpace: async () => ({ ok: true, space: { _id: "files-space" } }) as never,
        },
      };
      expect(await handleFileIndexJob(job, deps)).toMatchObject({
        kind: "indexed",
        truncated: false,
      });
      expect(ingestSource).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining(fact),
          readers,
          sourceId: job.fileId,
        })
      );
      const input = ingestSource.mock.calls[0]?.[0] as { content: string } | undefined;
      if (!input) throw new Error("Expected indexed Office content");
      const content = input.content;
      if (mediaType === XLSX_MEDIA_TYPE)
        expect(content).not.toMatch(/Hidden (row|column|sheet) secret/);
      else expect(content).toContain("Speaker notes");
      expect(setPageRestriction).not.toHaveBeenCalled();
    }
  );
});
