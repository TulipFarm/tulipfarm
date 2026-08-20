import type { ResolvedAttachment } from "../ports";
import type { LoopAttachmentPort } from "./contract";

/**
 * The Tool whose success puts a File in front of the model for the rest of this Turn.
 *
 * The loop knows this name for the same reason it knows `load_skill`: a Tool result is JSON with
 * no binary channel, so a Tool can say a File should be seen but cannot itself deliver the bytes.
 * The alternative — a general "attach anything" verb on the dispatch result — would let any Tool
 * push arbitrary bytes into a prompt, which is a far larger surface than one named read.
 */
export const FILE_READ_TOOL = "file_read";

/**
 * How many re-read Files ride along at once.
 *
 * Every one of them is re-sent on every remaining iteration, so the cost is bytes times steps and
 * an uncapped set is the runaway this bounds. When the model reads a fifth, the oldest is dropped
 * rather than the newest refused: the model has moved on, and refusing what it just asked for is
 * the confusing half of the trade.
 */
export const MAX_REREAD_FILES = 4;

/** One File an Agent asked to see again, named but not yet fetched. */
export interface RereadFile {
  readonly fileId: string;
  readonly mediaType: string;
  readonly name: string;
}

/**
 * The File a successful `file_read` asked to be shown, if it asked for one.
 *
 * A textual File comes back as characters in the result itself and needs nothing here; only the
 * `attached` answer names a File the model still has to see as bytes.
 */
export function extractRereadFile(output: unknown): RereadFile | undefined {
  if (typeof output !== "object" || output === null) return undefined;
  const value = output as Record<string, unknown>;
  if (value.attached !== true) return undefined;
  const { fileId, mediaType, filename } = value;
  if (typeof fileId !== "string" || fileId.length === 0) return undefined;
  if (typeof mediaType !== "string" || mediaType.length === 0) return undefined;
  return { fileId, mediaType, name: typeof filename === "string" ? filename : fileId };
}

/** Adds a File to the re-read set, most recent last, deduplicated, capped. */
export function rememberReread(
  current: readonly RereadFile[],
  next: RereadFile
): readonly RereadFile[] {
  const kept = current.filter((file) => file.fileId !== next.fileId);
  kept.push(next);
  return kept.slice(-MAX_REREAD_FILES);
}

/** The Turn's own attachments plus the re-read ones, each File carried exactly once. */
export function mergeAttachments(
  attached: readonly ResolvedAttachment[],
  reread: readonly ResolvedAttachment[]
): readonly ResolvedAttachment[] {
  const seen = new Set(attached.map((file) => file.fileId));
  return [...attached, ...reread.filter((file) => !seen.has(file.fileId))];
}

/**
 * The bytes one iteration sends: what the Turn attached, plus what the Agent re-read.
 *
 * Resolved per iteration rather than once, because the port's refusal *is* the authorization
 * check. A share revoked between the `file_read` and the next step comes back as nothing and the
 * File stops being sent, which no cached copy could honour.
 */
export async function resolveIterationAttachments(
  attached: readonly ResolvedAttachment[],
  reread: readonly RereadFile[],
  port: LoopAttachmentPort | undefined,
  runId: string
): Promise<readonly ResolvedAttachment[]> {
  if (port === undefined || reread.length === 0) return attached;
  const fetched = await Promise.all(
    reread.map(async (file) => {
      const data = await port.read(runId, file.fileId);
      return data === undefined ? undefined : { ...file, data };
    })
  );
  return mergeAttachments(
    attached,
    fetched.filter((file) => file !== undefined)
  );
}
