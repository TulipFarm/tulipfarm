export type McpIntegrationErrorCode =
  | "not_found"
  | "disabled"
  | "review_required"
  | "capability_changed"
  | "selection_required"
  | "consent_required"
  | "reconnect_required"
  | "forbidden"
  | "invalid_definition"
  | "unsupported"
  | "publication_failed"
  | "unavailable";

export class McpIntegrationError extends Error {
  readonly name = "McpIntegrationError";

  constructor(
    readonly code: McpIntegrationErrorCode,
    message: string
  ) {
    super(message);
  }
}
