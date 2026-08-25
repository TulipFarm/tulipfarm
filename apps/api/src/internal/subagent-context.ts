import {
  assembleContext,
  type ContextCandidate,
  DEFAULT_GUARDRAILS,
  type GuardrailsService,
  narrowDelegatedTurn,
} from "@tulipfarm/agent-runtime";
import { MAX_HISTORY_TOKENS, MAX_TOOL_STEPS } from "@tulipfarm/memory";
import type { ArtifactService, ChildLinkAncestry } from "@tulipfarm/run-kernel";
import {
  INVOKE_STATE_KEY,
  RUN_EXECUTOR_PRINCIPAL_REF,
  requestArtifactId,
} from "@tulipfarm/run-kernel";
import { canonicalHash, type SubagentRequest, textContent } from "@tulipfarm/schema";
import type { ToolRegistry } from "../broker/tool-adapter";
import { estimateTokens } from "../chat/compaction";
import type { HostedTurnContext, RunAuthority, SubagentContextResolver } from "./turn-host";
import { TurnAuthorityError } from "./turn-host";

/** Matches the chat resolver's repair budget; a sub-agent gets no more leeway than a Turn does. */
const MAX_REPAIR_ATTEMPTS = 2;

/** A sub-agent never picks a model: nothing in its request can express one. */
const SUBAGENT_MODEL_SELECTOR = "auto";

const SYSTEM_SOURCE_ID = "system";
const TASK_SOURCE_ID = "task";

const ALLOW = { decision: "allow" } as const;

/**
 * Declares the helper's two Context entries.
 *
 * The task is marked `untrusted` because a sub-agent's whole input was composed by a model, not
 * by an operator or a user — treating it as trusted would let the parent's output launder itself
 * into instruction-grade material. The persona keeps instruction precedence so the framing above
 * still outranks it, but at the delegated level rather than the Agent's own.
 */
function candidatesFor(system: string, task: string): readonly ContextCandidate[] {
  return [
    {
      sourceId: SYSTEM_SOURCE_ID,
      kind: "instruction",
      precedence: "agent_instructions",
      version: "1",
      classification: "internal",
      taint: "trusted",
      authorization: ALLOW,
      tokens: estimateTokens(system),
      digest: canonicalHash({ system }),
    },
    {
      sourceId: TASK_SOURCE_ID,
      kind: "message",
      precedence: "user_request",
      version: "1",
      classification: "internal",
      taint: "untrusted",
      authorization: ALLOW,
      tokens: estimateTokens(task),
      digest: canonicalHash({ task }),
    },
  ];
}

export interface SubagentTurnContextResolverOptions {
  readonly artifacts: ArtifactService;
  readonly toolRegistry?: ToolRegistry;
  readonly guardrails?: GuardrailsService;
  /** Delegation grants; a failed read refuses rather than falling back to an unbounded offer. */
  readonly childLinks?: ChildLinkAncestry;
  now?(): Date;
}

/**
 * Renders the helper's system prompt from the persona its caller authored.
 *
 * The framing is fixed and the persona is appended, never the other way round: instructions that
 * arrive from a model must not be able to redefine what a sub-agent structurally is.
 */
function systemPromptFor(persona: SubagentRequest["persona"]): string {
  return [
    `You are "${persona.name}", a sub-agent working on one task for another agent.`,
    "You answer once. There is no conversation, no user to ask, and no follow-up turn.",
    "If the task cannot be completed, say so plainly and explain what is missing.",
    "",
    persona.instructions,
  ].join("\n");
}

/** Renders the one user message: the task, plus whatever material the caller attached to it. */
function taskMessageFor(request: SubagentRequest): string {
  if (request.context === undefined) return request.task;
  return `${request.task}\n\n<context>\n${JSON.stringify(request.context, null, 2)}\n</context>`;
}

/**
 * Assembles the Context for a Conversation-less sub-agent Run.
 *
 * Mirrors {@link ChatTurnContextResolver} with three deliberate absences — no history, no
 * attachments and no presentation target — each of which follows from the same fact: a sub-agent
 * has no Conversation. Its whole input is the request Artifact its caller published.
 */
export class SubagentTurnContextResolver implements SubagentContextResolver {
  private readonly now: () => Date;

  constructor(private readonly options: SubagentTurnContextResolverOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async resolve(authority: RunAuthority): Promise<HostedTurnContext> {
    const request = await this.readRequest(authority);
    const system = systemPromptFor(request.persona);
    const task = taskMessageFor(request);

    const guardrails = this.options.guardrails;
    const guardrailPolicy = (guardrails?.config ?? DEFAULT_GUARDRAILS) as Record<string, unknown>;
    const guardrailDigest = guardrails?.revision ?? canonicalHash(DEFAULT_GUARDRAILS);

    const manifest = assembleContext({
      businessId: authority.businessId,
      runId: authority.runId,
      stateId: INVOKE_STATE_KEY,
      candidates: candidatesFor(system, task),
      guardrailDigest,
      bundleDigest: authority.bundleDigest,
      budgetTokens: MAX_HISTORY_TOKENS,
    });

    // A delegated Run may hold less than it asked for; the child link row knows how much. The
    // request's `toolNames` is the caller's *intent* — the link is the enforced bound.
    const delegated = await narrowDelegatedTurn(this.options.childLinks, authority, {
      tools: this.toolsFor(request),
      limits: {
        maxIterations: MAX_TOOL_STEPS,
        maxToolCalls: MAX_TOOL_STEPS,
        maxRepairAttempts: MAX_REPAIR_ATTEMPTS,
      },
    });

    return {
      agentId: request.persona.name,
      subjectId: authority.subject.id,
      modelProfileId: SUBAGENT_MODEL_SELECTOR,
      principal: { kind: authority.subject.kind, id: authority.subject.id },
      contextDigest: manifest.digest,
      guardrailDigest,
      guardrailPolicy,
      messages: [
        { role: "system", content: textContent(system) },
        { role: "user", content: textContent(task) },
      ],
      tools: delegated.tools,
      limits: delegated.limits,
      compacted: false,
    };
  }

  /**
   * Offers only the Tools the caller named, and nothing when it named none.
   *
   * Failing closed matters more here than for a chat Turn: a sub-agent's instructions were written
   * by a model, so a helper spawned without an explicit Tool list must not inherit the parent's.
   */
  private toolsFor(request: SubagentRequest): HostedTurnContext["tools"] {
    const requested = request.toolNames;
    if (requested === undefined || requested.length === 0) return [];
    const wanted = new Set(requested);
    return (this.options.toolRegistry?.getAll() ?? [])
      .filter((tool) => wanted.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        tier: tool.tier,
        mutating: tool.mutating,
      }));
  }

  private async readRequest(authority: RunAuthority): Promise<SubagentRequest> {
    const artifact = await this.options.artifacts.read({
      businessId: authority.businessId,
      artifactId: requestArtifactId(authority.runId),
      reader: RUN_EXECUTOR_PRINCIPAL_REF,
      allowedClassifications: [],
      now: this.now(),
    });
    const request = artifact.content as Partial<SubagentRequest>;
    // The Artifact was schema-validated when published, but a Run whose request cannot name a
    // persona has nothing to be, so it is refused rather than given a default identity.
    if (request.persona === undefined || request.task === undefined) {
      throw new TurnAuthorityError("turn_not_found");
    }
    return request as SubagentRequest;
  }
}
