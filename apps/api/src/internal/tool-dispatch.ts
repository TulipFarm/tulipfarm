import type { ArtifactService } from "@tulipfarm/run-kernel";
import { ajv } from "@tulipfarm/schema";
import type { SoulLoader } from "@tulipfarm/soul";
import type { ToolApprovalService } from "../approvals/tool-approvals";
import type { ToolRegistry } from "../broker/tool-adapter";
import { availableToolsFor } from "../chat/turn-helpers";
import { getDefaultAssistant, resolveAgent } from "../soul/agents/registry";
import type { RequestContext, ToolDef } from "../tools/types";
import { readChatRequest } from "./turn-context";
import type {
  HostedToolCall,
  HostedToolResult,
  TurnAuthority,
  TurnToolDispatcher,
} from "./turn-host";

/**
 * Executes one Tool call on a Run's behalf (plan §3).
 *
 * Two refusals happen before anything runs, in this order, because either alone would be a hole:
 * a Tool outside the Agent's allowlist is **denied** even though it exists, and arguments that do
 * not satisfy the Tool's schema are refused before `execute` sees them. Both come back as a result
 * the model reads, never as an exception — a denial the model can see is a denial it can work
 * around honestly, whereas a thrown error would end the turn with nothing to say.
 *
 * A gated call is refused a third way, and this one is not final: under `approval-required` a
 * mutating Tool comes back `awaiting_approval`, which parks the Run on a durable wait rather than
 * ending the turn. The decision is keyed by the *intent* — this Run, this Tool, these arguments —
 * so the call the resumed loop re-proposes is answered by the approval already given.
 *
 * The `RequestContext` is built from the Run's recorded subject. A worker that asked to run a Tool
 * "as" someone else has no field to say it in.
 */

export interface RegistryToolDispatcherOptions {
  readonly registry: ToolRegistry;
  readonly artifacts: ArtifactService;
  readonly soulLoader?: SoulLoader;
  /** Durable Tool approvals. Absent only where a deployment runs no gated Tools at all. */
  readonly approvals?: ToolApprovalService;
  now?(): Date;
}

/**
 * Whether this call needs a human before it runs.
 *
 * The same rule the in-process gate applied: only a mutating Tool, only under `approval-required`,
 * and only where the Tool has not opted out. Stated here rather than inherited so the Worker path
 * gates identically to the web path it replaces — a Slack turn must not be able to do what a web
 * turn would have to ask about.
 */
function needsApproval(definition: ToolDef, autonomy: string | undefined): boolean {
  return (
    autonomy === "approval-required" && definition.mutating && definition.requiresApproval !== false
  );
}

export class RegistryToolDispatcher implements TurnToolDispatcher {
  private readonly now: () => Date;

  constructor(private readonly options: RegistryToolDispatcherOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async dispatch(authority: TurnAuthority, call: HostedToolCall): Promise<HostedToolResult> {
    const request = await readChatRequest(this.options.artifacts, authority, this.now());
    const agent = resolveAgent(this.options.soulLoader, request.agentId);
    const allowed = new Set(
      availableToolsFor(this.options.registry, getDefaultAssistant(agent.name)).map(
        (tool) => tool.name
      )
    );
    const definition = this.options.registry
      .getAll()
      .find((tool: ToolDef) => tool.name === call.name);
    if (definition === undefined || !allowed.has(definition.name)) {
      return { status: "denied", reason: `tool "${call.name}" is not available to this turn` };
    }

    const validate = ajv.compile(definition.inputSchema);
    if (!validate(call.arguments)) {
      return { status: "invalid_arguments", reason: argumentErrors(validate) };
    }

    // Asked after validation and before `execute`, so a human is never shown a call the Tool would
    // have refused anyway, and no effect lands ahead of the decision.
    if (this.options.approvals && needsApproval(definition, request.autonomy)) {
      const decision = await this.options.approvals.decide({
        businessId: authority.businessId,
        runId: authority.runId,
        toolCallId: call.callId,
        toolName: definition.name,
        args: call.arguments,
      });
      if (decision.status === "pending") {
        return { status: "awaiting_approval", approvalId: decision.approvalId };
      }
      if (decision.status === "denied") {
        return { status: "denied", reason: decision.reason };
      }
    }

    const context: RequestContext = {
      userId: authority.subject.id,
      conversationId: authority.turn.conversationId,
      runId: authority.runId,
      agentId: agent.name,
    };
    let result: Awaited<ReturnType<ToolDef["execute"]>>;
    try {
      result = await definition.execute(call.arguments, context);
    } catch {
      // A Tool that threw may still have landed its effect, so this is `failed`, not `denied`:
      // the difference is what reconciliation is later allowed to assume.
      return { status: "failed", reason: `tool "${call.name}" raised an internal error` };
    }
    return result.success
      ? { status: "succeeded", output: result.data }
      : { status: "failed", reason: result.error.message };
  }
}

function argumentErrors(validate: ReturnType<typeof ajv.compile>): string {
  const messages = new Set(
    (validate.errors ?? []).map((error) =>
      `${error.instancePath || "(root)"} ${error.message ?? "is invalid"}`.trim()
    )
  );
  return [...messages].slice(0, 8).join("; ") || "invalid arguments";
}
