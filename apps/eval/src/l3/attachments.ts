import type { ToolDispatchPort } from "@tulipfarm/agent-runtime";
import {
  DocumentRefusedError,
  extractText,
  FileError,
  type FileRecord,
  fileReadTool,
} from "@tulipfarm/files";
import { isOfficePreviewable } from "@tulipfarm/files/office-preview";
import { externalPdf } from "@tulipfarm/files/test-fixtures/pdf";
import type { TurnAttachmentPort } from "@tulipfarm/turn-executor";
import { type EvalCase, synthesizeAttachment } from "../case.ts";

export function evalAttachments(evalCase: EvalCase): {
  readonly declared: ReturnType<typeof synthesizeAttachment>[];
  readonly port: TurnAttachmentPort;
  readonly tools?: ToolDispatchPort;
} {
  const declared = [...(evalCase.attachments ?? []), ...(evalCase.readable ?? [])].map(
    synthesizeAttachment
  );
  const library = new Map(declared.map((file) => [file.fileId, file.data]));
  const readable = new Map(
    (evalCase.readable ?? [])
      .filter((file) => file.pdf !== undefined)
      .map((file) => [file.fileId, file])
  );
  const read = async (_businessId: string, fileId: string, principalId: string) => {
    const file = readable.get(fileId);
    const bytes = library.get(fileId);
    if (principalId !== "eval" || file === undefined || bytes === undefined) {
      throw new FileError("not_found", "File is unavailable.");
    }
    return {
      id: fileId,
      filename: file.name,
      mediaType: file.mediaType,
      sizeBytes: bytes.length,
      ownerPrincipalId: "eval",
    } as FileRecord;
  };
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected File fixture operation");
  };
  const inspect: NonNullable<TurnAttachmentPort["inspect"]> = async (mediaType, bytes, signal) => {
    const result = await extractText(mediaType, bytes, { signal });
    if (result.kind === "refused") {
      const readablePdf =
        mediaType === "application/pdf" &&
        result.visual?.kind === "pdf" &&
        (result.reason === "needs_ocr" || result.reason === "no_text_layer");
      if (isOfficePreviewable(mediaType) || (mediaType === "application/pdf" && !readablePdf)) {
        if (result.reason === "image_not_extractable") throw new Error("Invalid document refusal");
        return { refusal: result.reason };
      }
    }
    return {
      ...(result.kind === "text" ? { text: result.text } : {}),
      ...(result.visual === undefined ? {} : { visual: result.visual }),
    };
  };
  return {
    declared,
    ...(readable.size === 0
      ? {}
      : {
          tools: {
            dispatch: async (request) => {
              const result = await fileReadTool.handler(request.arguments, {
                businessId: "eval",
                principalId: "eval",
                abortSignal: request.signal,
                service: {
                  read,
                  content: async (businessId, fileId, principalId) => ({
                    file: await read(businessId, fileId, principalId),
                    body: (async function* () {
                      const bytes = library.get(fileId);
                      if (bytes !== undefined) yield bytes.slice();
                    })(),
                  }),
                  list: unused,
                  listSharedWithMe: unused,
                  generate: unused,
                  generateDraft: unused,
                },
              });
              if (!result.success) {
                return { callId: request.callId, status: "failed", reason: result.error.message };
              }
              const args = request.arguments as { fileId: string };
              const replacement = readable.get(args.fileId)?.pdf?.replaceAfterRead;
              if (replacement !== undefined) library.set(args.fileId, externalPdf(replacement));
              return { callId: request.callId, status: "succeeded", output: result.data };
            },
          } satisfies ToolDispatchPort,
        }),
    port: {
      read: async (_runId, fileId) => library.get(fileId)?.slice(),
      extract: async (mediaType, bytes, signal) => {
        const inspected = await inspect(mediaType, bytes, signal);
        if (inspected.refusal !== undefined) throw new DocumentRefusedError(inspected.refusal);
        return inspected.text;
      },
      inspect,
    },
  };
}
