export type ToolTier = "system" | "platform" | "integration";

export type ToolErrorCode = "validation_error" | "oversize_value" | "not_found" | "internal_error";

export type ToolCallResult =
  | { success: true; data: unknown }
  | { success: false; error: { code: ToolErrorCode; message: string } };

export const ok = (data: unknown): ToolCallResult => ({ success: true, data });

export const err = (code: ToolErrorCode, message: string): ToolCallResult => ({
  success: false,
  error: { code, message },
});

/** Per-request caller identity. Service references are closed over at registration time. */
export interface RequestContext {
  userId: string;
  agentId?: string;
}

/** Canonical tool shape for the ToolRegistry (TOOL-V1). */
export interface ToolDef {
  name: string;
  tier: ToolTier;
  mutating: boolean;
  description: string;
  /** Plain JSON Schema — fed to AJV in the handler and to jsonSchema() for the LLM API. */
  inputSchema: Record<string, unknown>;
  execute: (args: unknown, ctx: RequestContext) => Promise<ToolCallResult>;
  requiresApproval?: boolean;
}
