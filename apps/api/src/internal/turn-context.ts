import {
  assembleContext,
  type ContextCandidate,
  DEFAULT_GUARDRAILS,
  type GuardrailsService,
  type ModelRequirementsPolicy,
  narrowDelegatedTurn,
} from "@tulipfarm/agent-runtime";
import type { KnowledgeService } from "@tulipfarm/knowledge";
import type { KvService } from "@tulipfarm/kv";
import type { MemoryDocumentRepo } from "@tulipfarm/memory";
import {
  MAX_HISTORY_TOKENS,
  MAX_TOOL_STEPS,
  MEMORY_METRICS,
  recordMemoryCounter,
  timezoneFromMemoryDocument,
} from "@tulipfarm/memory";
import type { TelemetryPort } from "@tulipfarm/observability";
import type { ArtifactService, ChildLinkAncestry } from "@tulipfarm/run-kernel";
import {
  chatRequestArtifactId,
  INVOKE_STATE_KEY,
  RUN_EXECUTOR_PRINCIPAL_REF,
  requestArtifactId,
} from "@tulipfarm/run-kernel";
import { canonicalHash } from "@tulipfarm/schema";
import type { BundledSkill, SoulAgent, SoulLoader } from "@tulipfarm/soul";
import {
  buildSoulCatalogue,
  getDefaultAssistant,
  listAvailableSkills,
  listEagerSkills,
  resolveAgent,
} from "@tulipfarm/soul";
import type { IntegrationStore } from "@tulipfarm/storage";
import type { PresentationContext } from "@tulipfarm/surface";
import type { ToolRegistry } from "../broker/tool-adapter";
import { estimateTokens } from "../chat/compaction";
import { assembleAgentSystemPrompt } from "../chat/system-prompt";
import {
  availableToolsFor,
  type RestrictedPlatformAgent,
  toolAgentFor,
} from "../chat/turn-helpers";
import type { ConversationStore, PersistedMessage } from "../conversations/service";
import { readCustomInstructions } from "../preferences/custom-instructions";
import { presentationContextFor, surfaceCatalogPromptFor } from "../surfaces/renderer-registry";
import { githubDisabledSkillNames, githubExcludedToolNames } from "../tools/github/visibility";
import { ModelSelectorDeniedError, type ModelSelectorGate } from "./model-authz";
import { resolveModelSelector } from "./model-selector";
import type { HostedTurnContext, TurnAuthority, TurnContextResolver } from "./turn-host";

/** Narrow read of one Run's Channel delivery correlation — just enough to resolve a target. */
export interface ChannelDeliveryReader {
  find(
    businessId: string,
    runId: string
  ): Promise<{ readonly provider: string; readonly destination: string } | null>;
}

/** Resolves the presentation target from channel delivery correlation, falling back to web chat. */
export async function presentationContextForAuthority(
  authority: TurnAuthority,
  channelDeliveries?: ChannelDeliveryReader
): Promise<PresentationContext> {
  const delivery = await channelDeliveries?.find(authority.businessId, authority.runId);
  if (delivery?.provider === "slack") {
    return presentationContextFor({ channel: "slack", surface: "message" }, delivery.destination);
  }
  if (delivery?.provider === "telegram") {
    return presentationContextFor(
      { channel: "telegram", surface: "message" },
      delivery.destination
    );
  }
  return presentationContextFor(
    { channel: "web", surface: "chat" },
    `conversation:${authority.turn.conversationId}`
  );
}

/** Resolves Worker Context from durable transcript and immutable request Artifacts. */

/** The per-turn parameters a chat request carries (`CHAT_REQUEST_SCHEMA`). */
export interface ChatRequestPayload {
  readonly agentId?: string;
  readonly model?: string;
  readonly autonomy?: string;
  readonly hasTools?: boolean;
  readonly llmDecision?: boolean;
}

/** Recall scores against the newest user message, never the assistant's own words. */
function latestUserMessage(history: readonly { role: string; content: string }[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message !== undefined && message.role === "user") return message.content;
  }
  return "";
}

/** Which Run source states its turn parameters directly, rather than through a derived Artifact. */
const CHAT_SOURCE = "chat";

/** Reads Chat Run parameters from the immutable request or derived chat-request Artifact. */
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
  readonly soulLoader?: SoulLoader;
  readonly toolRegistry?: ToolRegistry;
  /** The user's Memory Document. Absent leaves the `<memory>` block out of the prompt. */
  readonly memoryDocuments?: MemoryDocumentRepo;
  /**
   * Backs the user's standing `<custom-instructions>`. Absent leaves the block unrendered, which
   * is what every turn did before the setting existed.
   */
  readonly kv?: KvService;
  readonly knowledge?: KnowledgeService;
  readonly guardrails?: GuardrailsService;
  readonly bundledSkills?: ReadonlyMap<string, BundledSkill>;
  readonly disabledBundledSkills?: ReadonlySet<string>;
  readonly channelDeliveries?: ChannelDeliveryReader;
  /** Delegation grants; a failed read refuses rather than falling back to the Agent's config. */
  readonly childLinks?: ChildLinkAncestry;
  /** Live GitHub-install check backing per-turn tool visibility — absent only where a deployment
   * never wired the GitHub tool family at all. */
  readonly githubStatus?: { readonly integrations: IntegrationStore; readonly businessId: string };
  /**
   * Decides whether this turn's subject may use the model it named.
   *
   * Absent leaves the model path ungated, which is what every turn did before this existed; a
   * deployment wires it to put `platform.model` behind the one decision function.
   */
  readonly modelGate?: ModelSelectorGate;
  /**
   * Where a thinned-Context signal is emitted. Absent leaves the degradation silent, which is what
   * every turn did before this existed; a deployment wires it to measure the rate.
   */
  readonly telemetry?: TelemetryPort;
  now?(): Date;
}

/** Which Context probe fell back to an absence value. A bounded enum, never free text. */
const CONTEXT_PROBE_RECALLED_MEMORY = "recalled_memory";

export class ChatTurnContextResolver implements TurnContextResolver {
  private readonly now: () => Date;

  constructor(private readonly options: ChatTurnContextResolverOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async resolve(authority: TurnAuthority): Promise<HostedTurnContext> {
    const request = await readChatRequest(this.options.artifacts, authority, this.now());
    const agent = resolveAgent(this.options.soulLoader, request.agentId);
    const platformAgent = getDefaultAssistant(agent.name);
    const toolAgent = toolAgentFor(platformAgent, agent);
    const presentationContext = await presentationContextForAuthority(
      authority,
      this.options.channelDeliveries
    );
    const excludedTools = this.options.githubStatus
      ? await githubExcludedToolNames(this.options.githubStatus)
      : undefined;
    const disabledSkills = this.options.githubStatus
      ? new Set([
          ...(this.options.disabledBundledSkills ?? []),
          ...(await githubDisabledSkillNames(this.options.githubStatus)),
        ])
      : this.options.disabledBundledSkills;
    // History is read before the prompt because the prompt now depends on it: the retrieved memory
    // tier is scored against what the user just said. Nothing in the read depends on the prompt.
    const history = await this.options.store.listMessages(
      authority.businessId,
      authority.turn.conversationId
    );
    const system = await this.buildSystemPrompt(
      authority,
      agent,
      toolAgent,
      presentationContext,
      excludedTools,
      disabledSkills,
      latestUserMessage(history)
    );

    // Every Turn now resolves a presentation target (Channel destination, or the web chat surface
    // keyed by conversation), so the presentation Tools are offered for every channel alike.
    const allowed = availableToolsFor(
      this.options.toolRegistry,
      toolAgent,
      presentationContext,
      excludedTools
    );
    const allowedNames = new Set(allowed.map((tool) => tool.name));
    const tools = (this.options.toolRegistry?.getAll() ?? [])
      .filter((tool) => allowedNames.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        tier: tool.tier,
        mutating: tool.mutating,
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

    // A delegated Run may hold less than its Agent config offers; the link row knows how much.
    const delegated = await narrowDelegatedTurn(this.options.childLinks, authority, {
      tools,
      limits: {
        maxIterations: MAX_TOOL_STEPS,
        maxToolCalls: MAX_TOOL_STEPS,
        maxRepairAttempts: MAX_REPAIR_ATTEMPTS,
      },
    });

    const skillToolScopes = buildSkillToolScopes(
      this.options.soulLoader,
      this.options.bundledSkills
    );

    return {
      agentId: agent.name,
      subjectId: authority.subject.id,
      modelProfileId: await this.authorizeModelSelector(authority, agent, request),
      ...modelPolicyOf(agent),
      principal: { kind: authority.subject.kind, id: authority.subject.id },
      contextDigest: manifest.digest,
      guardrailDigest,
      guardrailPolicy,
      messages,
      tools: delegated.tools,
      limits: delegated.limits,
      compacted: dropped.size > 0,
      ...(skillToolScopes === undefined ? {} : { skillToolScopes }),
    };
  }

  /**
   * Resolves the requested model, having first asked whether this subject may use it.
   *
   * The selector arrives as a free string from the chat request body and used to reach the
   * provider having passed only a capability-fit check — a question about whether the model
   * *could* serve the turn, never about whether the caller was *allowed* to ask it to.
   *
   * The gate runs in shadow mode until there is evidence over real traffic, so a denial is
   * reported and the selector still resolves. Enforcement is a separate, evidenced flip.
   */
  private async authorizeModelSelector(
    authority: TurnAuthority,
    agent: ReturnType<typeof resolveAgent>,
    request: ChatRequestPayload
  ): Promise<string> {
    const selector = resolveModelSelector(request);
    const gate = this.options.modelGate;
    if (gate === undefined) return selector;

    const outcome = await gate.authorize({
      businessId: authority.businessId,
      subject: authority.subject,
      agentId: agent.name,
      selector,
    });
    if (outcome.enforced && outcome.wouldDeny) {
      throw new ModelSelectorDeniedError(selector, outcome.decision.reason);
    }
    return selector;
  }

  /**
   * Reports that this turn was assembled with thinner Context than it should have had.
   *
   * The counter carries only the probe, because Memory telemetry labels are bounded enums; the
   * correlation an operator needs to find the turn goes on the log record, which has run and
   * conversation fields for exactly that. Neither carries recalled content.
   */
  private signalThinnedContext(authority: TurnAuthority, probe: string): void {
    const telemetry = this.options.telemetry;
    if (telemetry === undefined) return;
    recordMemoryCounter(telemetry, MEMORY_METRICS.contextDegradations, 1, { probe });
    try {
      telemetry.log("warn", "agent context thinned: a context probe failed", {
        probe,
        business_id: authority.businessId,
        run_id: authority.runId,
        conversation_id: authority.turn.conversationId,
      });
    } catch {
      // Telemetry must never affect the turn it is describing.
    }
  }

  private async buildSystemPrompt(
    authority: TurnAuthority,
    agent: ReturnType<typeof resolveAgent>,
    platformAgent: RestrictedPlatformAgent | undefined,
    presentationContext: PresentationContext,
    excludedTools?: ReadonlySet<string>,
    disabledSkills?: ReadonlySet<string>,
    recallQuery?: string
  ): Promise<string> {
    const { soulLoader, knowledge, bundledSkills } = this.options;
    const disabledBundledSkills = disabledSkills ?? this.options.disabledBundledSkills;
    // Memory is a person's, so a Run acting as an Integration or an Agent has none to read.
    const forUser = authority.subject.kind === "user";
    const memoryDocument =
      this.options.memoryDocuments && forUser
        ? await this.options.memoryDocuments.render(authority.businessId, authority.subject.id)
        : undefined;
    // Same subject rule: standing instructions are a person's, so a Run acting as an Integration
    // or an Agent has none to honor.
    const customInstructions =
      this.options.kv && authority.subject.kind === "user"
        ? await readCustomInstructions(this.options.kv, authority.subject.id)
        : undefined;
    const governancePages = knowledge ? await knowledge.governancePages() : [];
    const manifest = soulLoader?.manifest;
    const surfaceComponents = [...(soulLoader?.surfaceComponents.values() ?? [])];

    return assembleAgentSystemPrompt({
      agent,
      platformAgent,
      business: {
        name: typeof manifest?.businessName === "string" ? manifest.businessName : undefined,
        description:
          typeof manifest?.businessDescription === "string"
            ? manifest.businessDescription
            : undefined,
        website:
          typeof manifest?.businessWebsite === "string" ? manifest.businessWebsite : undefined,
      },
      customInstructions,
      ...(memoryDocument === undefined ? {} : { memoryDocument }),
      governancePages,
      availableSkills: listAvailableSkills(soulLoader, bundledSkills, disabledBundledSkills),
      bundledSkills,
      disabledBundledSkills,
      eagerSkills: listEagerSkills(soulLoader, bundledSkills, disabledBundledSkills),
      taggedResources: [],
      soulCatalogue: buildSoulCatalogue(soulLoader),
      availableTools: availableToolsFor(
        this.options.toolRegistry,
        platformAgent,
        presentationContext,
        excludedTools
      ),
      surfaceCatalog: surfaceCatalogPromptFor(presentationContext.target, surfaceComponents),
      temporal: {
        now: this.now(),
        timezone:
          memoryDocument === undefined ? undefined : timezoneFromMemoryDocument(memoryDocument),
      },
    });
  }
}

/** Uses the stored `timezone` Memory value as-is; renderers validate and fall back to UTC. */
function timezoneFrom(memory: readonly { key: string; value: string }[]): string | undefined {
  return memory.find((entry) => entry.key === "timezone")?.value;
}

/** How many times the loop may ask the model to repair a malformed call before giving up. */
const MAX_REPAIR_ATTEMPTS = 2;

const SYSTEM_SOURCE_ID = "system";

/**
 * The Agent's authored model governance, read from validated `AGENT.md` frontmatter.
 *
 * The Soul loader has already validated the frontmatter against `AgentFrontmatterSchema`, so an
 * unparseable policy never reaches here. Absent stays absent: a turn that demands nothing must
 * keep matching profiles that declare nothing.
 */
function modelPolicyOf(agent: SoulAgent): { modelPolicy?: ModelRequirementsPolicy } {
  const policy = agent.frontmatter.modelPolicy;
  if (policy === undefined || policy === null || typeof policy !== "object") return {};
  return { modelPolicy: policy as ModelRequirementsPolicy };
}

/** Skill Tool scopes come from optional `tools:` frontmatter; absent scopes omit the wire field. */
function buildSkillToolScopes(
  soulLoader: SoulLoader | undefined,
  bundledSkills: ReadonlyMap<string, BundledSkill> | undefined
): Record<string, readonly string[]> | undefined {
  const scopes: Record<string, readonly string[]> = {};
  // Bundled first, Soul last — a Soul-authored override of a bundled Skill name must win, matching
  // `mergedSkills`/`resolveSkill` (soul/skills/registry.ts).
  const sources = [bundledSkills, soulLoader?.skills];
  for (const source of sources) {
    if (source === undefined) continue;
    for (const skill of source.values()) {
      const declared = skill.frontmatter.tools;
      if (!Array.isArray(declared)) continue;
      const names = declared.filter((entry): entry is string => typeof entry === "string");
      if (names.length > 0) scopes[skill.name] = names;
    }
  }
  return Object.keys(scopes).length > 0 ? scopes : undefined;
}

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
