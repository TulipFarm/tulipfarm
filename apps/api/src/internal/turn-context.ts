import {
  assembleContext,
  type ContextCandidate,
  DEFAULT_GUARDRAILS,
  type GuardrailsService,
} from "@tulipfarm/agent-runtime";
import type { LlmService } from "@tulipfarm/llm";
import type { ArtifactService } from "@tulipfarm/run-kernel";
import { canonicalHash } from "@tulipfarm/schema";
import type { SoulLoader } from "@tulipfarm/soul";
import type { ToolRegistry } from "../broker/tool-adapter";
import { estimateTokens } from "../chat/compaction";
import { assembleAgentSystemPrompt } from "../chat/system-prompt";
import { availableToolsFor } from "../chat/turn-helpers";
import type { ConversationStore, PersistedMessage } from "../conversations/service";
import type { KnowledgeService } from "../knowledge/service";
import { MAX_HISTORY_TOKENS, MAX_TOOL_STEPS } from "../memory/limits";
import type { WorkingMemoryService } from "../memory/service";
import {
  chatRequestArtifactId,
  INVOKE_STATE_KEY,
  RUN_EXECUTOR_PRINCIPAL_REF,
  requestArtifactId,
} from "../runtime/invocation-gateway";
import { getDefaultAssistant, resolveAgent } from "../soul/agents/registry";
import { buildSoulCatalogue } from "../soul/catalogue";
import type { BundledSkill } from "../soul/skills/bundled";
import { listAvailableSkills, listEagerSkills } from "../soul/skills/registry";
import type { HostedTurnContext, TurnAuthority, TurnContextResolver } from "./turn-host";

/**
 * Resolves one turn's Context for the Worker (plan §3).
 *
 * The prompt itself is still assembled by `assembleAgentSystemPrompt`, the same function the web
 * turn uses, so a Slack turn and a web turn are given byte-identical instructions for the same
 * Agent. What differs is where history comes from: this reads the **durable** Turn transcript, in
 * which an assistant Message only appears once an attempt's completion named it. That is what stops
 * a Worker that died after writing its reply from teaching the retry that it already answered.
 *
 * The request Artifact is the only source of per-turn parameters. Reading it rather than trusting
 * the caller is the point — it is immutable, it was validated when the Run was minted, and it is
 * what makes the turn reconstructable after any crash.
 */

/** The per-turn parameters a chat request carries (`CHAT_REQUEST_SCHEMA`). */
export interface ChatRequestPayload {
  readonly agentId?: string;
  readonly model?: string;
  readonly autonomy?: string;
  readonly hasTools?: boolean;
  readonly llmDecision?: boolean;
}

/** Which Run source states its turn parameters directly, rather than through a derived Artifact. */
const CHAT_SOURCE = "chat";

/**
 * The Chat request behind a Run, read as the Run executor.
 *
 * Shared with the Tool dispatcher so both answer "which Agent is this turn?" from the same
 * immutable record. Anything else would let a Tool run under an Agent whose instructions the model
 * was never given.
 *
 * Which Artifact that is follows from the Run's source, not from anything the caller says. A Chat
 * Run's request *is* a Chat request; every other source arrives as something else — a provider
 * envelope, a Trigger payload — and is answered only after a derived Chat request has been
 * published for it, with lineage back to what it came from.
 */
export async function readChatRequest(
  artifacts: ArtifactService,
  authority: TurnAuthority,
  now: Date
): Promise<ChatRequestPayload> {
  const artifact = await artifacts.read({
    businessId: authority.businessId,
    artifactId:
      authority.source === CHAT_SOURCE
        ? requestArtifactId(authority.runId)
        : chatRequestArtifactId(authority.runId),
    reader: RUN_EXECUTOR_PRINCIPAL_REF,
    allowedClassifications: [],
    now,
  });
  return artifact.content as ChatRequestPayload;
}

export interface ChatTurnContextResolverOptions {
  readonly artifacts: ArtifactService;
  readonly store: ConversationStore;
  readonly llmService: LlmService;
  readonly soulLoader?: SoulLoader;
  readonly toolRegistry?: ToolRegistry;
  readonly workingMemory?: WorkingMemoryService;
  readonly knowledge?: KnowledgeService;
  readonly guardrails?: GuardrailsService;
  readonly bundledSkills?: ReadonlyMap<string, BundledSkill>;
  readonly disabledBundledSkills?: ReadonlySet<string>;
  now?(): Date;
}

export class ChatTurnContextResolver implements TurnContextResolver {
  private readonly now: () => Date;

  constructor(private readonly options: ChatTurnContextResolverOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async resolve(authority: TurnAuthority): Promise<HostedTurnContext> {
    const request = await readChatRequest(this.options.artifacts, authority, this.now());
    const agent = resolveAgent(this.options.soulLoader, request.agentId);
    const platformAgent = getDefaultAssistant(agent.name);
    const system = await this.buildSystemPrompt(authority, agent, platformAgent);
    const history = await this.options.store.listMessages(
      authority.businessId,
      authority.turn.conversationId
    );

    // No presentation context: the Worker turn is not attached to a rendered surface, so the
    // presentation Tools are withheld rather than offered to a model that has nowhere to draw.
    // Channel parity gives each channel its own target and they come back for that channel.
    const allowed = availableToolsFor(this.options.toolRegistry, platformAgent);
    const allowedNames = new Set(allowed.map((tool) => tool.name));
    const tools = (this.options.toolRegistry?.getAll() ?? [])
      .filter((tool) => allowedNames.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        tier: tool.tier,
      }));

    // A deployment that composed no guardrails service still ships the default policy rather than
    // "nothing": the Worker enforces what arrives here, and the documented fallback for an absent
    // config is the default one — fail-safe, never unguarded.
    const guardrails = this.options.guardrails;
    const guardrailPolicy = (guardrails?.config ?? DEFAULT_GUARDRAILS) as Record<string, unknown>;
    const guardrailDigest = guardrails?.revision ?? canonicalHash(DEFAULT_GUARDRAILS);
    const manifest = assembleContext({
      businessId: authority.businessId,
      runId: authority.runId,
      stateId: INVOKE_STATE_KEY,
      candidates: candidatesFor(system, history),
      guardrailDigest,
      bundleDigest: authority.bundleDigest,
      budgetTokens: MAX_HISTORY_TOKENS,
    });
    const dropped = new Set(
      manifest.excluded
        .filter((exclusion) => exclusion.reason === "context_budget")
        .map((exclusion) => exclusion.sourceId)
    );

    const messages = [
      ...(system.length > 0 && !dropped.has(SYSTEM_SOURCE_ID)
        ? [{ role: "system", content: system }]
        : []),
      ...history
        .filter((message) => !dropped.has(message.id))
        .map((message) => ({ role: message.role, content: message.content })),
    ];

    return {
      agentId: agent.name,
      subjectId: authority.subject.id,
      modelProfileId: this.resolveModelId(request),
      contextDigest: manifest.digest,
      guardrailDigest,
      guardrailPolicy,
      messages,
      tools,
      limits: {
        maxIterations: MAX_TOOL_STEPS,
        maxToolCalls: MAX_TOOL_STEPS,
        maxRepairAttempts: MAX_REPAIR_ATTEMPTS,
      },
      compacted: dropped.size > 0,
    };
  }

  private resolveModelId(request: ChatRequestPayload): string {
    const resolved = this.options.llmService.resolve({
      ...(request.model === undefined ? {} : { sessionModel: request.model }),
      ...(request.hasTools === undefined ? {} : { hasTools: request.hasTools }),
      ...(request.llmDecision === undefined ? {} : { llmDecision: request.llmDecision }),
    });
    return resolved.modelId;
  }

  private async buildSystemPrompt(
    authority: TurnAuthority,
    agent: ReturnType<typeof resolveAgent>,
    platformAgent: ReturnType<typeof getDefaultAssistant>
  ): Promise<string> {
    const { soulLoader, workingMemory, knowledge, bundledSkills, disabledBundledSkills } =
      this.options;
    // Working memory is a person's, so a Run acting as an Integration or an Agent has none to read.
    const memory =
      workingMemory && authority.subject.kind === "user"
        ? await workingMemory.list(authority.subject.id)
        : [];
    const governancePages = knowledge ? await knowledge.governancePages() : [];
    const manifest = soulLoader?.manifest;

    return assembleAgentSystemPrompt({
      agent,
      platformAgent,
      business: {
        name: typeof manifest?.businessName === "string" ? manifest.businessName : undefined,
        description:
          typeof manifest?.businessDescription === "string"
            ? manifest.businessDescription
            : undefined,
      },
      memory,
      governancePages,
      availableSkills: listAvailableSkills(soulLoader, bundledSkills, disabledBundledSkills),
      bundledSkills,
      disabledBundledSkills,
      eagerSkills: listEagerSkills(soulLoader, bundledSkills, disabledBundledSkills),
      taggedResources: [],
      soulCatalogue: buildSoulCatalogue(soulLoader),
      availableTools: availableToolsFor(this.options.toolRegistry, platformAgent),
    });
  }
}

/** How many times the loop may ask the model to repair a malformed call before giving up. */
const MAX_REPAIR_ATTEMPTS = 2;

const SYSTEM_SOURCE_ID = "system";

/**
 * The Context manifest's candidates.
 *
 * History is offered **newest first** because the budget keeps candidates in the order they arrive:
 * feeding it oldest-first would keep the start of a long conversation and drop the message the user
 * just sent. The transcript sits at `user_request`, below the Agent's own instructions, so an
 * earlier message can never outrank the Agent, and the Agent's instructions are weighed against the
 * budget before any of it.
 */
function candidatesFor(
  system: string,
  history: readonly PersistedMessage[]
): readonly ContextCandidate[] {
  const allow = { decision: "allow" } as const;
  const instruction: ContextCandidate = {
    sourceId: SYSTEM_SOURCE_ID,
    kind: "instruction",
    precedence: "agent_instructions",
    version: "1",
    classification: "internal",
    taint: "trusted",
    authorization: allow,
    tokens: estimateTokens(system),
    digest: canonicalHash({ system }),
  };
  return [
    instruction,
    ...[...history].reverse().map(
      (message): ContextCandidate => ({
        sourceId: message.id,
        kind: "message",
        precedence: "user_request",
        version: "1",
        classification: "internal",
        taint: "trusted",
        authorization: allow,
        tokens: estimateTokens(message.content),
        digest: canonicalHash({ content: message.content }),
      })
    ),
  ];
}
