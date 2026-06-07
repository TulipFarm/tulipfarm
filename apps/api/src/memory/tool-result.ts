/**
 * Minimal platform-tool result contract (TOOLS AC-V1-001). A tool handler always resolves to a
 * `ToolCallResult` — it never throws — so a bad call is returned to the model for self-correction
 * (TOOL-V1-009) rather than aborting the turn.
 */
export type ToolErrorCode = "validation_error" | "oversize_value" | "internal_error";

export type ToolCallResult =
  | { success: true; data: unknown }
  | { success: false; error: { code: ToolErrorCode; message: string } };

export const ok = (data: unknown): ToolCallResult => ({ success: true, data });

export const err = (code: ToolErrorCode, message: string): ToolCallResult => ({
  success: false,
  error: { code, message },
});
