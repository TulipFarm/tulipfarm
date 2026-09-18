export type McpErrorCode =
  | "invalid_configuration"
  | "not_connected"
  | "closed"
  | "identity_mismatch"
  | "access_denied"
  | "authentication_required"
  | "unsupported_protocol"
  | "unsupported_capability"
  | "unsupported_backend"
  | "discovery_limit"
  | "response_limit"
  | "invalid_response"
  | "cancelled"
  | "timeout"
  | "transport_failure"
  | "protocol_failure";

export class McpError extends Error {
  readonly retryable = false;
  readonly httpStatus?: number;
  readonly protocolCode?: number;

  constructor(
    readonly code: McpErrorCode,
    readonly effect: "none" | "unknown" = "none",
    details: { readonly httpStatus?: number; readonly protocolCode?: number } = {}
  ) {
    super(`MCP ${code.replaceAll("_", " ")}`);
    this.name = "McpError";
    this.httpStatus = details.httpStatus;
    this.protocolCode = details.protocolCode;
  }
}
