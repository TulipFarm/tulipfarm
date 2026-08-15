import { ajv } from "@tulipfarm/schema";
import type { ToolAvailability } from "@tulipfarm/tool-broker";
import {
  type ApprovalGate,
  err,
  type RequestContext,
  type ToolCallResult,
  type ToolDef,
} from "@tulipfarm/tool-host";
import { jsonSchema, type ToolSet, tool } from "ai";
import type { BatchCoordinator } from "../tools/batch-executor";
import { truncateResult } from "../tools/truncate";

type AjvErrors = ReturnType<typeof ajv.compile>["errors"];

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
/** Read surface availability from Tool declarations to avoid drift. */
function presentsToSurface(toolDefinition: { definition?: { availableTo?: ToolAvailability } }) {
  return toolDefinition.definition?.availableTo?.requiresPresentation === true;
}

function withToolTimeout(p: Promise<ToolCallResult>): Promise<ToolCallResult> {
  return Promise.race([
    p,
    new Promise<ToolCallResult>((resolve) =>
      setTimeout(() => resolve(err("internal_error", "tool execution timed out")), TOOL_TIMEOUT_MS)
    ),
  ]);
}

/** Default-deny adapter: callers must pass the exact authorized Tool allowlist. */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();
  constructor(private readonly options: { defaultDeny?: boolean } = {}) {}

  register(tool: ToolDef, options: { replace?: boolean } = {}): void {
    ajv.compile(tool.inputSchema);
    if (this.tools.has(tool.name) && options.replace !== true) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
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
        ctx.presentationContext !== undefined || !presentsToSurface(toolDefinition)
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
            const isPresentationTool = presentsToSurface(t);
            if (
              isPresentationTool &&
              presentationValidationFailures > MAX_PRESENTATION_CORRECTIVE_ATTEMPTS
            ) {
              return err(
                "surface_invalid",
                "Surface correction limit reached. Do not call this presentation Tool again during " +
                  "this Turn. Answer now in plain Markdown text summarizing the data you already " +
                  "have — never tell the user a structured view was shown when it was not."
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
                  : " Correction limit reached; do not call this Tool again during this Turn. " +
                    "Answer now in plain Markdown text summarizing the data you already have — " +
                    "never tell the user a structured view was shown when it was not."
                : "";
              return err(
                "validation_error",
                `${argumentErrors(v.errors)}.${shapeHint}${correctionHint}`
              );
            }
            // Tool-call guard (GR-V1-001): after arg-validate, before approval. `block` denies;
            // `pass`/transform yields effectiveArgs. V1 guards do not mutate args, so effectiveArgs
            // is not re-validated. Undefined stays byte-identical.
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
            // Approval waits outside timeouts: minutes are allowed, siblings do not block.
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
