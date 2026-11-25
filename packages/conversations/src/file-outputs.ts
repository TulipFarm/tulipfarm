import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AccessDenied, type AuthorizationTransaction, type HumanActor } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { FileError, requireReadableFile, type createFiles } from '@tulipfarm/files';
import { bindFileSources, type FileSource } from './file-references.ts';
import { requireFileSources } from './source-access.ts';
import { sourceDependenciesSchema } from './results.ts';
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

const maximumBytes = 100 * 1024 * 1024;

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
  size: 'No file was created. Files are limited to 100 MiB.',
  quota: 'No file was created. Workspace storage is full.',
  busy: 'No file was created. Files is busy. Try again shortly.',
  conflict: 'No file was created. A different file already uses this request.',
} as const;
const isPublishFailure = (code: string): code is keyof typeof publishFailures => code in publishFailures;

export type ReadOfficeImage = OfficeImage & { fileId: string; sha256: string; readAt: string };

/** Reads each image a spec places as its author, or says which one cannot be used. */
export async function readOfficeImages(
  files: Pick<ReturnType<typeof createFiles>, 'download'>,
  context: { workspaceId: string; actor: HumanActor },
  ids: readonly string[],
): Promise<ReadOfficeImage[] | string> {
  if (ids.length > officeImageLimits.images)
    return `A document can place at most ${officeImageLimits.images} different images.`;
  const images: ReadOfficeImage[] = [];
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
    ? await readOfficeImages(files, context, officeImageIds(call.format, call.content))
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
        ...inputs.flatMap(source =>
          source.read ? [{ fileId: source.fileId, sha256: source.read.sha256, readAt: source.read.readAt }] : [],
        ),
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

/** Media types for the extensions a program usually writes; anything else is stored as plain bytes. */
const programOutputTypes: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  epub: 'application/epub+zip',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  ico: 'image/vnd.microsoft.icon',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
};
export function programOutputType(name: string) {
  const extension = name.includes('.') ? name.split('.').at(-1)!.toLowerCase() : '';
  return programOutputTypes[extension] ?? 'application/octet-stream';
}

/** One id per tool call and output path, so a retried call replays the same file instead of creating another. */
const machineStepSchema = z.object({ result: z.unknown(), sources: sourceDependenciesSchema });
const freshMachineSchema = z.object({ machine: z.literal('new') });

/**
 * The files this chat's earlier runs copied into its machine, which may still hold them: those of every
 * `execution.run` within the machine's longest life, back to the run that last started a new machine.
 */
export async function machineFileSources(
  tx: AuthorizationTransaction,
  conversationId: string,
  lifeMs: number,
): Promise<FileSource[]> {
  const steps = await tx.client.query<{ output: unknown }>(
    `SELECT s.output FROM ${qualified(tx.schema, 'tf_conversation_execution_steps')} s
      JOIN ${qualified(tx.schema, 'tf_conversation_tool_calls')} c ON c.id=s.call_id
      WHERE c.conversation_id=$1 AND c.tool='execution.run' AND s.output IS NOT NULL
        AND c.created_at > clock_timestamp() - make_interval(secs => $2)
      ORDER BY c.created_at DESC, c.id DESC LIMIT 1000`,
    [conversationId, lifeMs / 1000],
  );
  const result = new Map<string, FileSource>();
  for (const step of steps.rows) {
    const output = machineStepSchema.safeParse(step.output);
    if (!output.success) continue;
    for (const source of output.data.sources)
      if (source.kind === 'tulipfarm-file' || source.kind === 'library-file')
        result.set(JSON.stringify(source), source);
    if (freshMachineSchema.safeParse(output.data.result).success) break;
  }
  return [...result.values()];
}

/** Whether the requester can still read every file in `sources`. */
export async function canReadFileSources(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  sources: readonly FileSource[],
) {
  try {
    await requireFileSources(bindFileSources(tx), actor, sources);
    return true;
  } catch (error) {
    if (error instanceof AccessDenied) return false;
    throw error;
  }
}

export function programOutputId(callId: string, path: string) {
  const hash = createHash('sha256')
    .update(JSON.stringify(['program-output-v1', callId, path]))
    .digest();
  hash.writeUInt8((hash.readUInt8(6) & 0x0f) | 0x80, 6);
  hash.writeUInt8((hash.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type ProgramOutputResult =
  | { file: { id: string; name: string; mediaType: string; size: number } }
  | { error: 'destination-required' | 'invalid-content' | keyof typeof publishFailures; instruction: string };

/**
 * Saves a file a program wrote into Files, under the same destination rule as `files.create`. The turn's referenced
 * files and the files the program read are checked again in the publishing transaction, so a revoked input blocks it.
 */
export async function createProgramOutput(
  files: FileOutputStore,
  context: Omit<FileOutputContext, 'origin'> & {
    /** The chat files the turn referenced; a run has none. */
    origin?: Pick<FileOutputContext['origin'], 'files'> | undefined;
    callId: string;
    inputs: readonly FileSource[];
  },
  output: { path: string; bytes: Uint8Array; folderId?: string | undefined },
): Promise<ProgramOutputResult> {
  if (context.autonomous && !output.folderId)
    return {
      error: 'destination-required',
      instruction:
        'No file was saved. Work that no person requested in a private chat must name a Files folder the requester can add to. Ask for a destination folder.',
    };
  const name = output.path.split('/').at(-1)!.trim();
  if (!name || name.length > 200 || !output.bytes.byteLength)
    return {
      error: 'invalid-content',
      instruction: 'No file was saved. Write a non-empty file whose name has at most 200 characters.',
    };
  if (output.bytes.byteLength > maximumBytes) return { error: 'size', instruction: publishFailures.size };
  const mediaType = programOutputType(name);
  const sources = [...(context.origin?.files ?? []), ...context.inputs];
  try {
    const file = await files.createDerived(
      context.workspaceId,
      context.actor.userId,
      programOutputId(context.callId, output.path),
      { name, parentId: output.folderId ?? null, mediaType },
      output.bytes,
      tx => requireFileSources(bindFileSources(tx), context.actor, sources),
    );
    return {
      file: {
        id: file.id,
        name: file.name,
        mediaType: file.mediaType ?? mediaType,
        size: file.size ?? output.bytes.byteLength,
      },
    };
  } catch (error) {
    if (error instanceof FileError && isPublishFailure(error.code))
      return { error: error.code, instruction: publishFailures[error.code] };
    throw error;
  }
}
