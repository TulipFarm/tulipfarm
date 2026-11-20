type Ordered = { sequence: number; turnSequence?: number | null | undefined };

/**
 * Orders a transcript by the turn each message belongs to, then by when it was saved. A reply is saved when its
 * turn finishes, so a retried turn's reply has a later sequence than messages sent while it was failed, yet it
 * still answers the turn's own message.
 */
export function transcriptOrder<T extends Ordered>(messages: readonly T[]): T[] {
  return [...messages].sort(
    (a, b) => (a.turnSequence ?? a.sequence) - (b.turnSequence ?? b.sequence) || a.sequence - b.sequence,
  );
}
