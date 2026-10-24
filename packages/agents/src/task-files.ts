import type { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import { FileError } from '@tulipfarm/files';
import {
  googleFailure,
  sha256,
  type FileContent,
  type GoogleFileReader,
} from '@tulipfarm/conversations/file-references';
import { linkNotice, messageLinks, linkFetchConcurrency, type NoticedLink } from '@tulipfarm/conversations/links';
import type { FetchPublicFile } from '@tulipfarm/conversations/public-web';
import {
  readFailureText,
  readFile,
  taskFileContent,
  type AttachmentReader,
  type FileRecognition,
  type ReadFailure,
  type TaskFileRead,
} from '@tulipfarm/conversations/turn-files';
import type { TaskFileContent } from './model.ts';
import type { taskSourcesSchema } from './task-contracts.ts';

type TaskSource = z.infer<typeof taskSourcesSchema>[number];
type FileSource = Extract<TaskSource, { kind: 'attachment' | 'file' | 'google-drive-file' }>;
/** The task and owner a read is made for; recognition is charged to the owner's membership. */
type Scope = { workspaceId: string; userId: string; membershipId: string; taskId: string };

/**
 * How a task reads its file sources and instruction links while the workspace `images` flag is on: the chat reader,
 * with the same budget and recognition, so images reach image-reading families as images and others as recognised text.
 */
export type TaskFileReading = {
  enabled(workspaceId: string): Promise<boolean>;
  attachments?: AttachmentReader | undefined;
  files?: FileContent | undefined;
  google?: GoogleFileReader | undefined;
  /** The owner's recognizer on the workspace recognition model, and the image size that model accepts. */
  recognition(scope: Scope): Promise<{ recognition: FileRecognition | undefined; maxImageBytes: number }>;
  /** Fetches public links; absent, instruction links are left to `web.fetch`. */
  links?: FetchPublicFile | undefined;
};

/**
 * Why a step stops on a file before the model. A file that cannot be read, or that gets no room, is named with why;
 * `unsupported` is storage that is not configured and `access`, `source` and `provider` an unavailable Drive file.
 */
export type TaskFileStop =
  | { kind: 'unreadable'; name: string; reason: ReadFailure }
  | { kind: 'omitted'; name: string }
  | { kind: 'unsupported' | 'access' | 'source' | 'provider' };

/** The step's reading family: what its model reads, its input window and what an image costs it. */
export type TaskReadingFamily = {
  imageInput: boolean;
  maxInputTokens: number;
  imageInputTokens: number;
  maxImageBytes: number;
};

const representation = (mediaType: string): 'text' | 'extracted' =>
  mediaType.startsWith('text/') || ['application/json', 'application/xml'].includes(mediaType) ? 'text' : 'extracted';

async function readSource(
  reading: TaskFileReading,
  scope: Scope,
  source: FileSource,
  options: { imageInput: boolean; maxImageBytes: number; recognition: FileRecognition | undefined },
): Promise<{ read: TaskFileRead; receipt: TaskSource | null } | TaskFileStop> {
  if (source.kind === 'attachment') {
    if (!reading.attachments) return { kind: 'unsupported' };
    const file = await reading.attachments.download(
      scope.workspaceId,
      scope.userId,
      source.conversationId,
      source.attachmentId,
    );
    const result = await readFile({ name: file.filename, mediaType: file.mediaType, bytes: file.bytes }, options);
    return {
      read: {
        origin: 'attachment',
        id: source.attachmentId,
        name: file.filename,
        mediaType: file.mediaType,
        size: file.size,
        reading: result,
      },
      receipt: null,
    };
  }
  if (source.kind === 'file') {
    if (!reading.files) return { kind: 'unsupported' };
    const file = await reading.files
      .download(scope.workspaceId, scope.userId, source.fileId)
      .catch((error: unknown) => {
        throw error instanceof FileError && error.code === 'integrity' ? new AccessDenied() : error;
      });
    const mediaType = file.mediaType ?? 'application/octet-stream';
    const result = await readFile({ name: file.name, mediaType, bytes: file.bytes }, options);
    const read = {
      readAt: new Date().toISOString(),
      sha256: sha256(file.bytes),
      representation: representation(mediaType),
    };
    return {
      read: {
        origin: 'tulipfarm',
        id: source.fileId,
        name: file.name,
        mediaType,
        size: file.bytes.byteLength,
        reading: result,
      },
      receipt: { kind: 'file', fileId: source.fileId, read },
    };
  }
  const google = reading.google;
  if (!google) return { kind: 'unsupported' };
  const { fileId, integrationId, accountId, generation } = source;
  const request = { fileId, expectedIntegration: { integrationId, accountId, generation } };
  let file;
  try {
    file = await (google.fileDocument
      ? google.fileDocument(scope.workspaceId, scope.userId, request)
      : google.fileText(scope.workspaceId, scope.userId, request));
  } catch (error) {
    const failure = googleFailure(error);
    if (!failure) throw error;
    if (failure.kind === 'unreadable')
      return { kind: 'unreadable', name: `Google Drive file ${fileId}`, reason: failure.reason };
    // A busy or slow Google is not the file's fault: the step retries.
    if (failure.cause === 'busy') throw new Error('task-google-file-busy');
    return { kind: failure.cause };
  }
  const result = await readFile({ name: file.metadata.name, mediaType: file.contentType, bytes: file.bytes }, options);
  return {
    read: {
      origin: 'google',
      id: fileId,
      name: file.metadata.name,
      mediaType: file.metadata.mimeType,
      size: file.bytes.byteLength,
      reading: result,
    },
    receipt: {
      ...source,
      read: {
        readAt: new Date().toISOString(),
        sha256: sha256(file.bytes),
        ...(file.metadata.version ? { version: file.metadata.version } : {}),
        ...(file.metadata.modifiedTime ? { modifiedTime: file.metadata.modifiedTime } : {}),
        representation: file.representation === 'export' ? 'export' : representation(file.contentType),
      },
    },
  };
}

/** Reads the first five links of each owner message, three at a time; a failed link is named, never fatal. */
async function readLinks(
  fetch: FetchPublicFile,
  texts: readonly string[],
  options: { imageInput: boolean; maxImageBytes: number; recognition: FileRecognition | undefined },
) {
  const found = texts.map(text => messageLinks(text));
  const urls = [...new Set(found.flatMap(links => links.read))];
  const extra = [...new Set(found.flatMap(links => links.extra))].filter(url => !urls.includes(url));
  const notices: (NoticedLink | undefined)[] = [];
  const files: (TaskFileRead | undefined)[] = [];
  let webOff = false;
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const index = next++;
      const url = urls[index]!;
      const signal = AbortSignal.timeout(30_000);
      const result = await fetch(url, signal).catch(() => ({
        kind: 'failed' as const,
        url,
        reason: 'unavailable' as const,
      }));
      if (result.kind === 'failed') {
        if (result.reason === 'web-off') webOff = true;
        notices[index] = { url, outcome: 'failed', reason: result.reason };
        continue;
      }
      if (result.kind === 'page') {
        notices[index] = { url, outcome: 'page' };
        continue;
      }
      const reading = await readFile(
        { name: result.filename, mediaType: result.mediaType, bytes: result.bytes },
        { ...options, signal },
      );
      notices[index] = { url, outcome: 'file', filename: result.filename };
      files[index] = {
        origin: 'web',
        id: url,
        name: result.filename,
        mediaType: result.mediaType,
        size: result.bytes.byteLength,
        reading,
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(linkFetchConcurrency, urls.length) }, worker));
  return {
    files: files.filter(file => file !== undefined),
    notice: linkNotice(
      notices.filter(notice => notice !== undefined),
      extra,
      webOff,
      'the fetched-file block with this url',
    ),
  };
}

/**
 * Reads a step's file sources in order, then the links in the owner's messages, into the step's file content within
 * half of the family's input window. A source that cannot be read, or that gets no room, stops the step and is named.
 * `receipts` are the sources read, with what was read.
 */
export async function readTaskFiles(input: {
  reading: TaskFileReading;
  scope: Scope;
  family: TaskReadingFamily;
  sources: readonly FileSource[];
  instructions: readonly string[];
  /** False once the step's file-reading time is spent; the remaining sources are not read. */
  withinAllowance: () => boolean;
}): Promise<{ stop: TaskFileStop } | { content: TaskFileContent | null; receipts: TaskSource[] }> {
  const { reading, scope, family } = input;
  const recognised = await reading.recognition(scope);
  const options = {
    imageInput: family.imageInput,
    maxImageBytes: family.imageInput ? family.maxImageBytes : recognised.maxImageBytes,
    recognition: recognised.recognition,
  };
  const reads: TaskFileRead[] = [];
  const receipts: TaskSource[] = [];
  for (const source of input.sources) {
    if (!input.withinAllowance()) break;
    const result = await readSource(reading, scope, source, options);
    if ('kind' in result) return { stop: result };
    if (result.read.reading.kind === 'unreadable')
      return { stop: { kind: 'unreadable', name: result.read.name, reason: result.read.reading.reason } };
    reads.push(result.read);
    if (result.receipt) receipts.push(result.receipt);
  }
  const links =
    reading.links && input.instructions.length
      ? await readLinks(reading.links, input.instructions, options)
      : { files: [], notice: '' };
  if (!reads.length && !links.files.length && !links.notice) return { content: null, receipts };
  const { content, omitted } = taskFileContent([...reads, ...links.files], family, links.notice);
  const named = omitted.find(file => file.origin !== 'web');
  if (named) return { stop: { kind: 'omitted', name: named.name } };
  return { content: [...content], receipts };
}

/** What the owner reads when a step stops on a file it names. */
export function taskFileStopMessage(stop: Extract<TaskFileStop, { name: string }>): string {
  return stop.kind === 'unreadable'
    ? `The file ${JSON.stringify(stop.name)} could not be read. ${readFailureText(stop.reason)} Remove it or attach a readable copy, then continue the task.`
    : `The file ${JSON.stringify(stop.name)} was not read: the task's other files fill the model's reading budget. Its contents were not read. Remove some files, then continue the task.`;
}
