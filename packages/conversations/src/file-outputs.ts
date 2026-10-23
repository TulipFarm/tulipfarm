import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AccessDenied, type HumanActor } from '@tulipfarm/access';
import { FileError, requireReadableFile, type createFiles } from '@tulipfarm/files';
import { bindFileSources, type FileSource } from './file-references.ts';
import { requireFileSources } from './source-access.ts';
import {
  OfficeSpecError,
  officeFormats,
  officeImageIds,
  officeImageInfo,
  officeImageLimits,
  renderOfficeDocument,
  type OfficeFormat,
  type OfficeImage,
} from './office-documents.ts';

const maximumBytes = 10 * 1024 * 1024;

export const createFileCallSchema = z.strictObject({
  tool: z.literal('files.create'),
  name: z.string(),
  format: z.enum(['md', 'txt', 'csv', 'json', 'docx', 'xlsx', 'pptx']),
  content: z
    .string()
    .describe(
      'File text. For docx, xlsx, and pptx, a JSON document spec; read the word-document, excel-workbook, or powerpoint-deck skill first.',
    ),
  folderId: z.uuid().optional(),
});
export type CreateFileCall = z.infer<typeof createFileCallSchema>;
/** The media type each format an agent may write is stored under. */
export const fileOutputFormats: Record<CreateFileCall['format'], string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  ...officeFormats,
};
const isOffice = (format: CreateFileCall['format']): format is OfficeFormat => format in officeFormats;
export type FileOutputStore = Pick<ReturnType<typeof createFiles>, 'createDerived' | 'download'>;

export type FileOutputContext = {
  workspaceId: string;
  actor: HumanActor;
  /** Private chats requested by a person may default to that person's files; anything else must name a folder. */
  autonomous: boolean;
  origin: { turnId: string; files?: readonly FileSource[] | undefined };
};

export type FileOutputResult =
  | {
      file: { id: string; name: string; mediaType: string; size: number; parentId: string | null };
      derivedFrom: { fileId: string; sha256: string; readAt: string }[];
      instruction: string;
    }
  | { error: 'destination-required' | 'invalid-content' | keyof typeof publishFailures; instruction: string };

/** One id per turn and exact call, so a retried tool call replays the same file instead of creating another. */
export function fileOutputId(turnId: string, call: CreateFileCall) {
  const hash = createHash('sha256')
    .update(JSON.stringify(['files.create', turnId, call.name, call.format, call.folderId ?? null, call.content]))
    .digest();
  hash.writeUInt8((hash.readUInt8(6) & 0x0f) | 0x80, 6);
  hash.writeUInt8((hash.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const publishFailures = {
  size: 'No file was created. Files are limited to 10 MiB.',
  quota: 'No file was created. Workspace storage is full.',
  busy: 'No file was created. Files is busy. Try again shortly.',
  conflict: 'No file was created. A different file already uses this request.',
} as const;
const isPublishFailure = (code: string): code is keyof typeof publishFailures => code in publishFailures;

type ReadImage = OfficeImage & { fileId: string; sha256: string; readAt: string };

/** Reads each image a spec places as the author, or says which one cannot be used. */
async function readImages(
  files: FileOutputStore,
  context: FileOutputContext,
  ids: readonly string[],
): Promise<ReadImage[] | string> {
  if (ids.length > officeImageLimits.images)
    return `A document can place at most ${officeImageLimits.images} different images.`;
  const images: ReadImage[] = [];
  for (const fileId of ids) {
    let bytes: Uint8Array;
    try {
      ({ bytes } = await files.download(context.workspaceId, context.actor.userId, fileId));
    } catch (error) {
      if (error instanceof AccessDenied || (error instanceof FileError && error.code === 'integrity'))
        return `Image ${fileId} can't be read. Use a file the person can open in Files.`;
      throw error;
    }
    if (bytes.byteLength > officeImageLimits.bytes)
      return `Image ${fileId} is over ${officeImageLimits.bytes / 1024 / 1024} MiB. Use a smaller image.`;
    const info = officeImageInfo(bytes);
    if (!info) return `Image ${fileId} is not a PNG, JPEG, or GIF. Use an image in one of those formats.`;
    images.push({
      ...info,
      bytes,
      fileId,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      readAt: new Date().toISOString(),
    });
  }
  return images;
}

const outputName = (call: CreateFileCall) =>
  call.name.trim().toLowerCase().endsWith(`.${call.format}`) ? call.name.trim() : `${call.name.trim()}.${call.format}`;

/**
 * Writes an agent output into Files. Storage is written and verified before the ready row commits,
 * and the turn's referenced files and the images placed in an Office spec are checked again in that transaction,
 * so a revoked or changed input blocks the output with AccessDenied.
 */
export async function createFileOutput(
  files: FileOutputStore,
  context: FileOutputContext,
  call: CreateFileCall,
): Promise<FileOutputResult> {
  if (context.autonomous && !call.folderId)
    return {
      error: 'destination-required',
      instruction:
        'No file was created. Work that no person requested in a private chat must name a Files folder the requester can add to. Ask for a destination folder.',
    };
  if (!call.name.trim() || call.name.length > 200 || !call.content)
    return {
      error: 'invalid-content',
      instruction: 'No file was created. Give a name of at most 200 characters and non-empty content.',
    };
  if (call.format === 'json') {
    try {
      JSON.parse(call.content);
    } catch {
      return {
        error: 'invalid-content',
        instruction: 'No file was created. The content is not valid JSON. Correct it and create the file again.',
      };
    }
  }
  const images = isOffice(call.format)
    ? await readImages(files, context, officeImageIds(call.format, call.content))
    : [];
  if (typeof images === 'string') return { error: 'invalid-content', instruction: `No file was created. ${images}` };
  let content: Uint8Array;
  try {
    content = isOffice(call.format)
      ? await renderOfficeDocument(call.format, call.content, new Map(images.map(image => [image.fileId, image])))
      : new TextEncoder().encode(call.content);
  } catch (error) {
    if (error instanceof OfficeSpecError)
      return {
        error: 'invalid-content',
        instruction: `No file was created. The document spec is invalid: ${error.message}`,
      };
    throw error;
  }
  if (content.byteLength > maximumBytes) return { error: 'size', instruction: publishFailures.size };
  const inputs = context.origin.files ?? [];
  try {
    const file = await files.createDerived(
      context.workspaceId,
      context.actor.userId,
      fileOutputId(context.origin.turnId, call),
      { name: outputName(call), parentId: call.folderId ?? null, mediaType: fileOutputFormats[call.format] },
      content,
      async tx => {
        await requireFileSources(bindFileSources(tx), context.actor, inputs);
        for (const image of images)
          if ((await requireReadableFile(tx, context.actor, image.fileId)).sha256 !== image.sha256)
            throw new AccessDenied();
      },
    );
    return {
      file: {
        id: file.id,
        name: file.name,
        mediaType: file.mediaType ?? fileOutputFormats[call.format],
        size: file.size ?? content.byteLength,
        parentId: file.parentId,
      },
      derivedFrom: [
        ...inputs.map(source => ({ fileId: source.fileId, sha256: source.read.sha256, readAt: source.read.readAt })),
        ...images
          .filter(image => !inputs.some(source => source.fileId === image.fileId))
          .map(({ fileId, sha256, readAt }) => ({ fileId, sha256, readAt })),
      ],
      instruction:
        'The file is saved in Files and shown as a card under your reply. Refer to it by name. Do not paste its full content again.',
    };
  } catch (error) {
    if (error instanceof FileError && isPublishFailure(error.code))
      return { error: error.code, instruction: publishFailures[error.code] };
    throw error;
  }
}
