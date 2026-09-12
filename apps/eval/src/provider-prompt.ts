import type { CaseAttachment } from "./case.ts";
import type { Observation } from "./scorer.ts";

type DeclaredFile = CaseAttachment & { readonly data: Uint8Array };
type ProviderFile = NonNullable<Observation["providerPromptFiles"]>[number];

function bytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return undefined;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Attributes provider-native binary parts to immutable Case fixtures.
 *
 * Runtime attachments are deliberately not an input. They are the value under test: comparing an
 * emitted part with them would call upstream corruption exact, and a leaked File omitted from
 * them would disappear from the observation.
 */
export function observeProviderPromptFiles(
  messages: readonly { readonly content: unknown }[],
  declared: readonly DeclaredFile[]
): readonly ProviderFile[] {
  const observed: ProviderFile[] = [];

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const unknownPart of message.content) {
      const part = unknownPart as {
        type?: unknown;
        image?: unknown;
        data?: unknown;
        mediaType?: unknown;
        filename?: unknown;
      };
      if (part.type !== "image" && part.type !== "file") continue;
      const emitted = bytes(part.type === "image" ? part.image : part.data);
      if (emitted === undefined) {
        observed.push({
          part: part.type,
          ...(typeof part.mediaType === "string" ? { mediaType: part.mediaType } : {}),
          ...(typeof part.filename === "string" ? { filename: part.filename } : {}),
          bytesExact: false,
          mediaTypeExact: false,
          filenameExact: false,
        });
        continue;
      }

      const available = declared.map((file) => ({ file }));
      const exact = available.filter(({ file }) => sameBytes(emitted, file.data));
      const named = available.filter(
        ({ file }) => part.filename === file.name && part.mediaType === file.mediaType
      );
      const sameMedia = available.filter(({ file }) => part.mediaType === file.mediaType);
      const matched =
        exact.length === 1
          ? exact[0]
          : named.length === 1
            ? named[0]
            : sameMedia.length === 1
              ? sameMedia[0]
              : undefined;

      if (matched === undefined) {
        observed.push({
          part: part.type,
          ...(typeof part.mediaType === "string" ? { mediaType: part.mediaType } : {}),
          ...(typeof part.filename === "string" ? { filename: part.filename } : {}),
          bytesExact: false,
          mediaTypeExact: false,
          filenameExact: false,
        });
        continue;
      }

      observed.push({
        fileId: matched.file.fileId,
        part: part.type,
        ...(typeof part.mediaType === "string" ? { mediaType: part.mediaType } : {}),
        ...(typeof part.filename === "string" ? { filename: part.filename } : {}),
        bytesExact: sameBytes(emitted, matched.file.data),
        mediaTypeExact: part.mediaType === matched.file.mediaType,
        filenameExact: part.type === "image" || part.filename === matched.file.name,
      });
    }
  }
  return observed;
}
