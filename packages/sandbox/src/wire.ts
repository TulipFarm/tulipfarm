/** Strict wire-value assertions shared by the sandbox request, result, and signature parsers. */

export type SandboxProtocolErrorCode =
  | "backend_failure"
  | "compute_limit_exceeded"
  | "egress_denied"
  | "guardrail_missing"
  | "invalid_attestation"
  | "invalid_attestation_signature"
  | "invalid_request_signature"
  | "invalid_result_shape"
  | "invalid_result_signature"
  | "request_expired"
  | "request_lifetime_exceeded"
  | "request_not_current"
  | "request_replayed"
  | "result_binding_mismatch"
  | "result_limit_exceeded"
  | "unsafe_request_shape"
  | "weak_backend_isolation"
  | "workspace_limit_exceeded"
  | "workspace_not_destroyed";

const ERROR_MESSAGES: Readonly<Record<SandboxProtocolErrorCode, string>> = {
  backend_failure: "sandbox backend failed",
  compute_limit_exceeded: "sandbox compute limit denied",
  egress_denied: "sandbox egress denied",
  guardrail_missing: "sandbox guardrail is required",
  invalid_attestation: "sandbox backend attestation is invalid",
  invalid_attestation_signature: "sandbox backend attestation signature is invalid",
  invalid_request_signature: "sandbox request signature is invalid",
  invalid_result_shape: "sandbox result is invalid",
  invalid_result_signature: "sandbox result signature is invalid",
  request_expired: "sandbox request has expired",
  request_lifetime_exceeded: "sandbox request lifetime exceeds the guardrail",
  request_not_current: "sandbox request is not current",
  request_replayed: "sandbox request has already been claimed",
  result_binding_mismatch: "sandbox result does not match the request",
  result_limit_exceeded: "sandbox result exceeded an execution limit",
  unsafe_request_shape: "sandbox request contains an unsafe or invalid field",
  weak_backend_isolation: "sandbox backend cannot satisfy production isolation",
  workspace_limit_exceeded: "sandbox workspace limit denied",
  workspace_not_destroyed: "sandbox workspace destruction was not attested",
};

export class SandboxProtocolError extends Error {
  constructor(readonly code: SandboxProtocolErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "SandboxProtocolError";
  }
}

type UnknownRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertRecord(value: unknown, code: SandboxProtocolErrorCode): UnknownRecord {
  if (!isRecord(value)) {
    throw new SandboxProtocolError(code);
  }
  return value;
}

export function assertExactKeys(
  value: UnknownRecord,
  keys: readonly string[],
  code: SandboxProtocolErrorCode
): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new SandboxProtocolError(code);
  }
  if (keys.some((key) => !(key in value))) {
    throw new SandboxProtocolError(code);
  }
}

export function assertKeysWithOptional(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[],
  code: SandboxProtocolErrorCode
): void {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new SandboxProtocolError(code);
  }
  if (required.some((key) => !(key in value))) {
    throw new SandboxProtocolError(code);
  }
}

export function requireString(value: unknown, code: SandboxProtocolErrorCode): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new SandboxProtocolError(code);
  }
  return value;
}

export function requireInteger(
  value: unknown,
  code: SandboxProtocolErrorCode,
  minimum = 0
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new SandboxProtocolError(code);
  }
  return value as number;
}

export function requireBoolean(value: unknown, code: SandboxProtocolErrorCode): boolean {
  if (typeof value !== "boolean") {
    throw new SandboxProtocolError(code);
  }
  return value;
}

export function requireStringArray(
  value: unknown,
  code: SandboxProtocolErrorCode
): readonly string[] {
  if (!Array.isArray(value) || value.length > 1_000) {
    throw new SandboxProtocolError(code);
  }
  return value.map((item) => requireString(item, code));
}

export function requireSafeRelativePath(value: unknown, code: SandboxProtocolErrorCode): string {
  const path = requireString(value, code);
  const segments = path.split("/");
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new SandboxProtocolError(code);
  }
  return path;
}
