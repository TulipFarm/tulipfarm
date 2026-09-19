import type { McpToolResult } from "@tulipfarm/mcp";

export const MCP_TOOL_ERROR_REASONS = Object.freeze({
  mcp_tool_auth_rejected:
    "Provider reported rejected authentication. This does not identify which credential failed.",
  mcp_tool_access_denied:
    "Provider reported denied access. Check this account's repository or resource permissions.",
  mcp_tool_not_found:
    "Provider reported the resource was not found or is inaccessible. This does not prove it is absent.",
  mcp_tool_invalid_input: "Provider reported invalid request input.",
  mcp_tool_rate_limited: "Provider reported a rate limit.",
  mcp_tool_provider_unavailable: "Provider reported a server failure or temporary unavailability.",
});

type SafeCode = keyof typeof MCP_TOOL_ERROR_REASONS;
type Classification = SafeCode | "mcp_tool_failed";
const MAX_ERROR_BYTES = 8_192;
const MAX_CONTENT_ITEMS = 8;

const HTTP_ERRORS: Readonly<Record<number, readonly [SafeCode, readonly string[]]>> = {
  400: ["mcp_tool_invalid_input", ["Bad Request"]],
  401: ["mcp_tool_auth_rejected", ["Unauthorized", "Bad credentials"]],
  403: [
    "mcp_tool_access_denied",
    [
      "Forbidden",
      "Resource not accessible by personal access token",
      "Resource not accessible by integration",
    ],
  ],
  404: ["mcp_tool_not_found", ["Not Found"]],
  422: ["mcp_tool_invalid_input", ["Unprocessable Entity", "Validation Failed"]],
  429: ["mcp_tool_rate_limited", ["Too Many Requests", "API rate limit exceeded"]],
  500: ["mcp_tool_provider_unavailable", ["Internal Server Error"]],
  502: ["mcp_tool_provider_unavailable", ["Bad Gateway"]],
  503: ["mcp_tool_provider_unavailable", ["Service Unavailable"]],
  504: ["mcp_tool_provider_unavailable", ["Gateway Timeout"]],
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function consistent(codes: readonly Classification[]): Classification | undefined {
  if (codes.length === 0) return undefined;
  return new Set(codes).size === 1 ? codes[0] : "mcp_tool_failed";
}

function structuredCode(value: unknown): Classification | undefined {
  if (!record(value)) return undefined;
  const codes: Classification[] = [];
  for (const envelope of [value, ...(record(value.error) ? [value.error] : [])]) {
    for (const key of ["status", "statusCode", "httpStatus"]) {
      if (!(key in envelope)) continue;
      const raw = envelope[key];
      const status =
        typeof raw === "number"
          ? raw
          : typeof raw === "string" && /^[1-5]\d{2}$/.test(raw)
            ? Number(raw)
            : undefined;
      codes.push(
        (status === undefined ? undefined : HTTP_ERRORS[status]?.[0]) ?? "mcp_tool_failed"
      );
    }
    if (envelope.code === -32602) codes.push("mcp_tool_invalid_input");
  }
  return consistent(codes);
}

function textCode(text: string): Classification | undefined {
  const value = text.trim();
  if (value.startsWith("{")) {
    try {
      return structuredCode(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (value === "Invalid params") return "mcp_tool_invalid_input";
  const request =
    /^(?:failed to [a-z][a-z ]{0,79}: )?(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) https:\/\/[^\s]{1,2048}: ([1-5]\d{2}) ([^\r\n]{1,160})$/i.exec(
      value
    ) ?? /^HTTP\/(?:1\.[01]|2(?:\.0)?) ([1-5]\d{2}) ([^\r\n]{1,160})$/.exec(value);
  if (request) {
    const status = Number(request[1]);
    const reason = request[2]?.replace(/ \[\]$/, "").toLowerCase();
    if (status === 403 && reason === "api rate limit exceeded") return "mcp_tool_rate_limited";
    const known = HTTP_ERRORS[status];
    return known?.[1].some((signature) => signature.toLowerCase() === reason)
      ? known[0]
      : undefined;
  }
  for (const [code, signatures] of Object.values(HTTP_ERRORS)) {
    if (signatures.some((signature) => signature.toLowerCase() === value.toLowerCase()))
      return code;
  }
  return undefined;
}

/** Advisory evidence only: never infer authorization, effect certainty, or retry safety. */
export function classifyMcpToolError(result: McpToolResult): Classification {
  if (result.isError !== true || result.content.length > MAX_CONTENT_ITEMS)
    return "mcp_tool_failed";
  try {
    const codes: Classification[] = [];
    let bytes = 0;
    if (result.structuredContent !== undefined) {
      bytes += Buffer.byteLength(JSON.stringify(result.structuredContent));
      if (bytes > MAX_ERROR_BYTES) return "mcp_tool_failed";
      const code = structuredCode(result.structuredContent);
      if (code !== undefined) codes.push(code);
    }
    for (const item of result.content) {
      if (item.type !== "text") return "mcp_tool_failed";
      bytes += Buffer.byteLength(item.text);
      if (bytes > MAX_ERROR_BYTES) return "mcp_tool_failed";
      const code = textCode(item.text);
      if (code !== undefined) codes.push(code);
    }
    return consistent(codes) ?? "mcp_tool_failed";
  } catch {
    return "mcp_tool_failed";
  }
}
