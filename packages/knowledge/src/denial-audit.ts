/**
 * One write this actor was refused.
 *
 * Deliberately carries no subject identifier. `write_page` and `POST /spaces/:id/pages` upsert by
 * `(spaceId, path)`, so refusing a taken path tells a caller who may read the Space that *something*
 * sits there. That bit cannot be removed — succeeding would overwrite the hidden Page and refusing
 * every write would make the Space read-only — so it is answered with detection instead: a burst of
 * refusals from one actor is the probing signature.
 *
 * Recording the path, Page id or Space id would defeat the point, re-exposing the withheld subject
 * to every reader of the audit ledger. `auditRetrieval` targets the Knowledge boundary for the same
 * reason.
 */
export interface KnowledgeWriteDenial {
  /** Absent for an unauthenticated caller, which is itself worth seeing in the ledger. */
  readonly actorId: string | undefined;
  /** The attempted operation, e.g. `knowledge.page.write`. */
  readonly action: string;
  /** Whether the actor aimed at a Page or the Space itself — the shape, never the identity. */
  readonly subjectKind: "page" | "space";
  /** The Agent that attempted the write, when one did. */
  readonly agentId?: string;
  readonly correlationId?: string;
}

/**
 * Where refused writes go. Implemented by the host over its audit ledger, so this package never
 * writes audit records itself.
 *
 * Implementations must not throw: a ledger outage may not change what the caller is told, or the
 * refusal itself becomes distinguishable from an ordinary "not found".
 */
export interface KnowledgeDenialSink {
  recordWriteDenial(denial: KnowledgeWriteDenial): Promise<void>;
}

/**
 * Records a refusal without ever letting the ledger affect the answer. A sink that rejects is
 * swallowed, because the alternative is an availability failure that doubles as a side channel.
 */
export async function recordWriteDenial(
  sink: KnowledgeDenialSink | undefined,
  denial: KnowledgeWriteDenial
): Promise<void> {
  if (sink === undefined) return;
  try {
    await sink.recordWriteDenial(denial);
  } catch {
    // Intentionally swallowed; see above.
  }
}
