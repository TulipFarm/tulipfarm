export class OimKnowledgeRetryRequiredError extends Error {
  readonly code = "retry_required";

  constructor(readonly operationId: string) {
    super(`OIM Knowledge operation "${operationId}" must be retried`);
    this.name = "OimKnowledgeRetryRequiredError";
  }
}

export function isOimKnowledgeRetryRequiredError(
  error: unknown
): error is OimKnowledgeRetryRequiredError {
  return error instanceof OimKnowledgeRetryRequiredError;
}
