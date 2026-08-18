import { contentFiles, type MessageContent } from "@tulipfarm/schema";

/**
 * Which Files a Turn may send to a model, and how its bytes are fetched.
 *
 * Both answers are File-authorization policy, not HTTP: they need a message list, a File store and
 * a subject, and nothing else. They live here rather than beside the routes that expose them so the
 * rule has one home — the manifest the Context carries and the bytes the Worker later fetches must
 * agree about which Files this Turn attached, and two copies of that rule would be free to drift.
 */

/** The narrow read of `FileService` needed to re-authorize one File and describe it. */
export interface TurnAttachmentReader {
  read(
    businessId: string,
    id: string,
    principalId: string
  ): Promise<{ id: string; mediaType: string; filename: string }>;
}

/** The narrow read of `FileService` needed to serve one File's bytes. */
export interface TurnAttachmentStore {
  content(
    businessId: string,
    id: string,
    principalId: string
  ): Promise<{
    readonly file: { readonly mediaType: string; readonly sizeBytes: number };
    readonly body: AsyncIterable<Uint8Array>;
  }>;
}

/** A durable Message, reduced to what decides whether it attached a File to this Turn. */
export interface AttachedMessage {
  readonly turnId?: string | null;
  readonly content: MessageContent;
}

/** One File named in a Turn's Context, without its bytes. */
export interface TurnAttachmentRef {
  readonly fileId: string;
  readonly mediaType: string;
  readonly name: string;
}

/** Told when a File was dropped, so a Turn missing content is explainable rather than mysterious. */
export type AttachmentOmitted = (fileId: string) => void;

function attachedToTurn(message: AttachedMessage, turnId: string): boolean {
  return message.turnId === turnId;
}

/**
 * The Files this Turn may send, each re-authorized here rather than trusted.
 *
 * A message part carries a reference and messages are durable, so the check that ran when the File
 * was attached says nothing about now. This is the check that gates bytes: a subject who cannot
 * read a File cannot get its contents into a prompt by naming it, however the reference got into
 * the transcript.
 *
 * Scoped to this Turn's own messages by `turnId`. That is what stops a File being re-sent on every
 * later Turn of the conversation — around a tenfold difference in input tokens over ten Turns —
 * and an Agent that needs the File again re-reads it through a Tool.
 */
export async function resolveTurnAttachments(input: {
  readonly files: TurnAttachmentReader;
  readonly messages: readonly AttachedMessage[];
  readonly businessId: string;
  readonly turnId: string;
  readonly principalId: string;
  readonly onOmitted?: AttachmentOmitted;
}): Promise<TurnAttachmentRef[]> {
  const refs: TurnAttachmentRef[] = [];
  for (const message of input.messages) {
    if (!attachedToTurn(message, input.turnId)) continue;
    for (const part of contentFiles(message.content)) {
      try {
        const record = await input.files.read(input.businessId, part.fileId, input.principalId);
        refs.push({ fileId: record.id, mediaType: record.mediaType, name: record.filename });
      } catch {
        // The File was authorized when attached and is not now, so authority was revoked in
        // between. Omitting it is the only safe answer, but it is not a silent one: the Turn
        // proceeds without content the person expects the Agent to have seen, and an operator
        // needs to be able to find out why.
        input.onOmitted?.(part.fileId);
      }
    }
  }
  return refs;
}

/**
 * The bytes of one File this Turn attached, or `null` when it did not attach it.
 *
 * Two gates, both necessary. The Turn's own messages must name the File, which stops a caller
 * holding one Run from reading any File it can name; and the File must still authorize for the
 * Run's subject, which is the check that a durable reference in a durable message can never
 * substitute for. Only the second would be enough for safety, and only the first would be enough
 * for scoping — a File needs both.
 */
export async function readTurnAttachment(input: {
  readonly files: TurnAttachmentStore;
  readonly messages: readonly AttachedMessage[];
  readonly businessId: string;
  readonly turnId: string;
  readonly fileId: string;
  readonly principalId: string;
}): Promise<{ mediaType: string; sizeBytes: number; body: AsyncIterable<Uint8Array> } | null> {
  const attached = input.messages.some(
    (message) =>
      attachedToTurn(message, input.turnId) &&
      contentFiles(message.content).some((part) => part.fileId === input.fileId)
  );
  if (!attached) return null;

  try {
    const { file, body } = await input.files.content(
      input.businessId,
      input.fileId,
      input.principalId
    );
    return { mediaType: file.mediaType, sizeBytes: file.sizeBytes, body };
  } catch {
    // A File the subject may no longer read is indistinguishable, to this caller, from one the
    // Turn never attached. Both mean "no bytes for you", and saying which would tell a caller
    // that an id it cannot read nonetheless exists.
    return null;
  }
}
