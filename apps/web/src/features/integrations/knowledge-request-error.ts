// Base error for Knowledge source HTTP failures. Feature modules set the user-facing message.
export class KnowledgeRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
