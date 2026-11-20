/** Failure types the Knowledge Keep workflow reads to decide whether to wait for Keep or move to the next document. */
export const knowledgeKeepFailures = {
  /** Keep cannot be reached or is not ready: every document would fail the same way. */
  keep: 'KnowledgeKeepUnreachable',
  /** Only this document's call failed, such as a timeout; it backs off and the run moves on. */
  document: 'KnowledgeKeepDocumentFailed',
  /** A fault a retry will not fix. */
  permanent: 'KnowledgeKeepFailed',
} as const;
