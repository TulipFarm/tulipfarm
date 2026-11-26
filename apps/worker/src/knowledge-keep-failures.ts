/** Failure types the Knowledge Keep workflow reads to decide whether to wait for Keep or move to the next document. */
export const knowledgeKeepFailures = {
  /** Keep cannot be reached or is not ready: every document would fail the same way. */
  keep: 'KnowledgeKeepUnreachable',
  /** Keep timed out, most likely because it is overloaded: the run waits, then resumes the same document. */
  busy: 'KnowledgeKeepBusy',
  /** Only this document's call failed; it backs off and the run moves on. */
  document: 'KnowledgeKeepDocumentFailed',
  /** A fault a retry will not fix. */
  permanent: 'KnowledgeKeepFailed',
} as const;
