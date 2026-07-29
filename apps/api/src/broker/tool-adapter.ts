import { ajv } from "@tulipfarm/schema";
import { jsonSchema, type ToolSet, tool } from "ai";
import type { BatchCoordinator } from "../tools/batch-executor";
import { truncateResult } from "../tools/truncate";
import {
  type ApprovalGate,
  err,
  type RequestContext,
  type ToolCallResult,
  type ToolDef,
} from "../tools/types";

type AjvErrors = ReturnType<typeof ajv.compile>["errors"];

/** Outcome of the tool-call guard hook (GR-V1-001). AW-014 routes import these. */
export type ToolGuardOutcome =
  | { blocked: true; reason: string }
  | { blocked: false; args: unknown };
export type RunToolCallGuard = (input: {
  tool: ToolDef;
  args: unknown;
  ctx: RequestContext;
  toolCallId: string;
}) => Promise<ToolGuardOutcome>;

function argumentErrors(errors: AjvErrors): string {
  const messages = new Set(
    (errors ?? []).map((error) =>
      `${error.instancePath || "(root)"} ${error.message ?? "is invalid"}`.trim()
    )
  );
  return [...messages].slice(0, 8).join("; ") || "invalid arguments";
}

export const TOOL_TIMEOUT_MS = 30_000;
export const MAX_PRESENTATION_CORRECTIVE_ATTEMPTS = 2;
const PRESENTATION_TOOL_NAMES = new Set(["present", "update_presentation", "request_input"]);

function withToolTimeout(p: Promise<ToolCallResult>): Promise<ToolCallResult> {
  return Promise.race([
    p,
    new Promise<ToolCallResult>((resolve) =>
      setTimeout(() => resolve(err("internal_error", "tool execution timed out")), TOOL_TIMEOUT_MS)
    ),
  ]);
}

/**
 * Compatibility adapter from published Tool definitions to the AI SDK. Exposure is always
 * default-deny: the caller must provide the exact Tool allowlist produced by authorization.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();
  constructor(private readonly options: { defaultDeny?: boolean } = {}) {}

  register(tool: ToolDef): void {
    this.tools.set(tool.name, tool);
    ajv.compile(tool.inputSchema);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  getAll(): ToolDef[] {
    return [...this.tools.values()];
  }

  buildToolSet(
    ctx: RequestContext,
    coordinator?: BatchCoordinator,
    fullResultCache?: Map<string, ToolCallResult>,
    approvalGate?: ApprovalGate,
    runToolCallGuard?: RunToolCallGuard,
    allowedToolNames?: ReadonlySet<string>
  ): ToolSet {
    let presentationValidationFailures = 0;
    const authorized = allowedToolNames
      ? this.getAll().filter((toolDefinition) => allowedToolNames.has(toolDefinition.name))
      : this.options.defaultDeny
        ? []
        : this.getAll();
    const exposed = authorized.filter(
      (toolDefinition) =>
        ctx.presentationContext !== undefined || !PRESENTATION_TOOL_NAMES.has(toolDefinition.name)
    );
    return Object.fromEntries(
      exposed.map((t) => [
        t.name,
        tool({
          description: t.description,
          inputSchema: jsonSchema(
            (t.inputSchemaFor?.(ctx) ?? t.inputSchema) as Parameters<typeof jsonSchema>[0]
          ),
          execute: async (args: unknown, opts: { toolCallId: string }) => {
            const isPresentationTool = PRESENTATION_TOOL_NAMES.has(t.name);
            if (
              isPresentationTool &&
              presentationValidationFailures > MAX_PRESENTATION_CORRECTIVE_ATTEMPTS
            ) {
              return err(
                "surface_invalid",
                "Surface correction limit reached. Do not call this presentation Tool again during this Turn."
              );
            }
            const schema = t.inputSchemaFor?.(ctx) ?? t.inputSchema;
            const v = ajv.compile(schema);
            if (!v(args)) {
              if (isPresentationTool) presentationValidationFailures += 1;
              const shapeHint = isPresentationTool
                ? ' Expected component shape: {"name":"ComponentName","version":"1.0","props":{...}}. Keep name and version separate.'
                : "";
              const attemptsRemaining = isPresentationTool
                ? Math.max(
                    0,
                    MAX_PRESENTATION_CORRECTIVE_ATTEMPTS + 1 - presentationValidationFailures
                  )
                : 0;
              const correctionHint = isPresentationTool
                ? attemptsRemaining > 0
                  ? ` ${attemptsRemaining} corrective attempt${attemptsRemaining === 1 ? "" : "s"} remaining.`
                  : " Correction limit reached; do not call this Tool again during this Turn."
                : "";
              return err(
                "validation_error",
                `${argumentErrors(v.errors)}.${shapeHint}${correctionHint}`
              );
            }
            // Tool-call guard (GR-V1-001): runs after arg-validate, before the approval gate. A `block`
            // returns a denial the LLM sees (AC-V1-002). A `pass`/transform yields effectiveArgs — the
            // transform path is plumbed but unused by V1 guards, so effectiveArgs is NOT re-validated
            // against the tool schema (no V1 guard mutates tool args). Undefined → byte-identical to before.
            let effectiveArgs = args;
            if (runToolCallGuard) {
              const g = await runToolCallGuard({ tool: t, args, ctx, toolCallId: opts.toolCallId });
              if (g.blocked) {
                const denied = err("internal_error", `blocked by guardrail: ${g.reason}`);
                fullResultCache?.set(opts.toolCallId, denied);
                return truncateResult(denied);
              }
              effectiveArgs = g.args;
            }
            // Mode-gated approval: a mutating tool under approval-required suspends here until a human
            // decides. Deliberately OUTSIDE coordinator + withToolTimeout — the wait can be minutes, and
            // sibling approval requests must not serialize behind each other or auto-fail at 30s.
            if (
              ctx.autonomy === "approval-required" &&
              t.mutating &&
              t.requiresApproval !== false &&
              approvalGate
            ) {
              const decision = await approvalGate.request({
                toolCallId: opts.toolCallId,
                toolName: t.name,
                args,
              });
              if (decision.outcome !== "approved") {
                const denied = err("internal_error", decision.reason);
                fullResultCache?.set(opts.toolCallId, denied);
                return truncateResult(denied);
              }
            }
            let full: ToolCallResult;
            try {
              full = await (coordinator
                ? coordinator.schedule(
                    () => withToolTimeout(t.execute(effectiveArgs, ctx)),
                    t.mutating
                  )
                : withToolTimeout(t.execute(effectiveArgs, ctx)));
            } catch {
              full = err(
                "internal_error",
                isPresentationTool
                  ? "The presentation could not be created because the server encountered an internal error."
                  : "The Tool could not be completed because the server encountered an internal error."
              );
            }
            fullResultCache?.set(opts.toolCallId, full);
            return truncateResult(full);
          },
        }),
      ])
    );
  }
}
