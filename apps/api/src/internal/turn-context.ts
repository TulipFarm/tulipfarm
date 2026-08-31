import {
  assembleContext,
  type ContextCandidate,
  DEFAULT_GUARDRAILS,
  type GuardrailsService,
  type ModelRequirementsPolicy,
  narrowDelegatedTurn,
  type SoulReminderPinned,
} from "@tulipfarm/agent-runtime";
import {
  resolveTurnAttachments,
  type TurnAttachmentReader,
  type TurnAttachmentRef,
} from "@tulipfarm/files";
import { MAX_HISTORY_TOKENS, MAX_TOOL_STEPS } from "@tulipfarm/memory";
import type { TelemetryPort } from "@tulipfarm/observability";
import type { ArtifactService, ChildLinkAncestry } from "@tulipfarm/run-kernel";
import {
  chatRequestArtifactId,
  INVOKE_STATE_KEY,
  RUN_EXECUTOR_PRINCIPAL_REF,
  requestArtifactId,
} from "@tulipfarm/run-kernel";
import type { AgentCapabilityRestrictions } from "@tulipfarm/schema";
import { canonicalHash, contentText, textContent } from "@tulipfarm/schema";
import type { BundledSkill, SoulAgent, SoulLoader } from "@tulipfarm/soul";
import { getDefaultAssistant, resolveAgent } from "@tulipfarm/soul";
import type { IntegrationStore } from "@tulipfarm/storage";
import type { PresentationContext } from "@tulipfarm/surface";
import type { RequestContext } from "@tulipfarm/tool-host";
import type { ToolRegistry } from "../broker/tool-adapter";
import { estimateTokens } from "../chat/compaction";
import { assembleAgentSystemPrompt } from "../chat/system-prompt";
import { availableToolsFor, toolAgentFor } from "../chat/turn-helpers";
import type { ConversationStore, PersistedMessage } from "../conversations/service";
import {
  type MemoryDocumentReader,
  resolveSoulReminder,
  type SubjectAuthorityLayers,
} from "../soul/reminder";
import {
  presentationContextFor,
  surfaceCatalogFor,
  surfaceCatalogRevisionFor,
  surfaceRendererRegistry,
} from "../surfaces/renderer-registry";
import { githubExcludedToolNames } from "../tools/github/visibility";
import { ModelSelectorDeniedError, type ModelSelectorGate } from "./model-authz";
import { resolveModelSelector } from "./model-selector";
import type { HostedTurnContext, TurnAuthority, TurnContextResolver } from "./turn-host";
import { TurnAuthorityError } from "./turn-host";

/** Narrow read of one Run's Channel delivery correlation — just enough to resolve a target. */
export interface ChannelDeliveryReader {
  find(
    businessId: string,
    runId: string
  ): Promise<{ readonly provider: string; readonly destination: string } | null>;
}

/** Resolves the presentation target from channel delivery correlation, falling back to web chat. */
export async function presentationContextForAuthority(
  authority: ChatTurnAuthority,
  channelDeliveries?: ChannelDeliveryReader
): Promise<PresentationContext> {
  const delivery = await channelDeliveries?.find(authority.businessId, authority.runId);
  if (delivery?.provider === "slack") {
    return presentationContextFor({ channel: "slack", surface: "message" }, delivery.destination);
  }
  return presentationContextFor(
    { channel: "web", surface: "chat" },
    `conversation:${authority.turn.conversationId}`
  );
}

/**
 * Run authority that names a Turn. Everything a Chat Turn assembles is conversation-scoped, so a
 * Run without one is refused rather than given an invented conversation.
 */
type ChatTurnAuthority = TurnAuthority & { readonly turn: NonNullable<TurnAuthority["turn"]> };

/** Resolves Worker Context from durable transcript and immutable request Artifacts. */

/** The per-turn parameters a chat request carries (`CHAT_REQUEST_SCHEMA`). */
export interface ChatRequestPayload {
  readonly agentId?: string;
  readonly model?: string;
  readonly autonomy?: string;
  readonly hasTools?: boolean;
  readonly llmDecision?: boolean;
  /**
   * What the participant pinned in the composer while writing the message.
   *
   * Each names an artifact the Agent is already told about in the Soul reminder, so a pin points
   * attention rather than widening reach. `resources` holds Resource type names, matching the
   * wire schema rather than the reminder's field name.
   */
  readonly skills?: readonly string[];
  readonly resources?: readonly string[];
  readonly knowledgePages?: readonly string[];
}

/** Which Run source states its turn parameters directly, rather than through a derived Artifact. */
const CHAT_SOURCE = "chat";

/** Reads Chat Run parameters from the immutable request or derived chat-request Artifact. */
export async function readChatRequest(
  artifacts: ArtifactService,
  authority: ChatTurnAuthority,
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

export type { SubjectAuthorityLayers } from "../soul/reminder";
export interface ChatTurnContextResolverOptions {
  readonly artifacts: ArtifactService;
  readonly store: ConversationStore;
  readonly soulLoader?: SoulLoader;
  readonly toolRegistry?: ToolRegistry;
  readonly guardrails?: GuardrailsService;
  readonly bundledSkills?: ReadonlyMap<string, BundledSkill>;
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
   * Resolves the live authority layers that narrow the Soul reminder to this subject.
   *
   * Absent renders no reminder, which is what every Turn did before it existed — the catalogue
   * stays reachable through `skill_list`, `agent_list` and the rest, as it always was.
   */
  readonly authorityLayers?: SubjectAuthorityLayers /**
   * Where a thinned-Context signal is emitted. Absent leaves the degradation silent, which is what
   * every turn did before this existed; a deployment wires it to measure the rate.
   */;
  /**
   * The subject's Memory Document and standing instructions, for the reminder's personal blocks.
   *
   * Absent renders both blocks `(none)`, which is honest — the Turn genuinely carries neither —
   * and leaves `get_memory` as the way to reach them, exactly as before.
   */
  readonly memory?: MemoryDocumentReader;
  readonly customInstructions?: (userId: string) => Promise<string | undefined>;
  readonly telemetry?: TelemetryPort;
  /**
   * Reads the Files this Turn attached, so their authorization can be checked again here.
   *
   * Absent leaves every Turn attachment-free, which is what every Turn did before Files existed.
   */
  readonly files?: TurnAttachmentReader;
  now?(): Date;
}

export class ChatTurnContextResolver implements TurnContextResolver {
  private readonly now: () => Date;

  constructor(private readonly options: ChatTurnContextResolverOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async resolve(turnAuthority: TurnAuthority): Promise<HostedTurnContext> {
    const { turn } = turnAuthority;
    // A Chat Turn is assembled entirely from its conversation; a Run without one has nothing here
    // to assemble, and inventing a conversation for it would attach its Messages to a stranger's.
    if (turn === undefined) throw new TurnAuthorityError("turn_not_found");
    const authority: ChatTurnAuthority = { ...turnAuthority, turn };
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
    const history = await this.options.store.listMessages(
      authority.businessId,
      authority.turn.conversationId
    );
    const system = assembleAgentSystemPrompt({ agent });
    const soulReminder = await this.soulReminder(authority, toolAgent?.capabilityRestrictions, {
      ...(request.skills === undefined ? {} : { skills: request.skills }),
      ...(request.resources === undefined ? {} : { resourceTypes: request.resources }),
      ...(request.knowledgePages === undefined ? {} : { knowledgePages: request.knowledgePages }),
    });

    // Every Turn now resolves a presentation target (Channel destination, or the web chat surface
    // keyed by conversation), so the presentation Tools are offered for every channel alike.
    const allowed = availableToolsFor(
      this.options.toolRegistry,
      toolAgent,
      presentationContext,
      excludedTools
    );
    const allowedNames = new Set(allowed.map((tool) => tool.name));
    const surfaceComponents = [...(this.options.soulLoader?.surfaceComponents.values() ?? [])];
    const toolContext: RequestContext = {
      userId: authority.subject.id,
      conversationId: authority.turn.conversationId,
      runId: authority.runId,
      agentId: platformAgent?.name,
      presentationContext,
      surfaceCatalog: surfaceCatalogFor(presentationContext.target, surfaceComponents),
      surfaceCatalogRevision: surfaceCatalogRevisionFor(
        presentationContext.target,
        surfaceComponents
      ),
      surfaceRendererManifest: surfaceRendererRegistry.manifestFor(presentationContext.target),
      surfaceComponents,
    };
    const tools = (this.options.toolRegistry?.getAll() ?? [])
      .filter((tool) => allowedNames.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchemaFor?.(toolContext) ?? tool.inputSchema,
        tier: tool.tier,
        mutating: tool.mutating,
        sideEffecting: tool.sideEffecting,
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
      candidates: candidatesFor(system, soulReminder, history),
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
        ? [{ role: "system", content: textContent(system) }]
        : []),
      // Sits before all history so the cached prompt prefix stays stable across a conversation,
      // and reads as standing context rather than as something the participant just said.
      ...(soulReminder.length > 0 && !dropped.has(SOUL_REMINDER_SOURCE_ID)
        ? [{ role: "user", content: textContent(soulReminder) }]
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

    const attachments = await this.resolveAttachments(authority, history);

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
      ...(attachments.length === 0 ? {} : { attachments }),
      tools: delegated.tools,
      limits: delegated.limits,
      compacted: dropped.size > 0,
      ...(skillToolScopes === undefined ? {} : { skillToolScopes }),
    };
  }

  /** What this instance's Soul holds, narrowed to what this Turn's subject and Agent may reach. */
  private async soulReminder(
    authority: TurnAuthority,
    agentRestrictions: AgentCapabilityRestrictions | undefined,
    pinned: SoulReminderPinned
  ): Promise<string> {
    return resolveSoulReminder({
      ...(this.options.authorityLayers === undefined
        ? {}
        : { authorityLayers: this.options.authorityLayers }),
      ...(this.options.soulLoader === undefined ? {} : { soulLoader: this.options.soulLoader }),
      ...(this.options.memory === undefined ? {} : { memory: this.options.memory }),
      ...(this.options.customInstructions === undefined
        ? {}
        : { customInstructions: this.options.customInstructions }),
      ...(agentRestrictions === undefined ? {} : { agentRestrictions }),
      pinned,
      businessId: authority.businessId,
      subjectId: authority.subject.id,
      subjectKind: authority.subject.kind,
      now: this.now(),
    });
  }

  /** Delegates to the File domain, which owns which Files a Turn may send. */
  private async resolveAttachments(
    authority: ChatTurnAuthority,
    history: readonly PersistedMessage[]
  ): Promise<TurnAttachmentRef[]> {
    const files = this.options.files;
    if (files === undefined) return [];
    return resolveTurnAttachments({
      files,
      messages: history,
      businessId: authority.businessId,
      turnId: authority.turn.id,
      principalId: authority.subject.id,
      onOmitted: (fileId) => {
        this.options.telemetry?.log("warn", "turn attachment omitted: no longer authorized", {
          "tulip.file.id": fileId,
          "tulip.turn.id": authority.turn.id,
          "tulip.subject.id": authority.subject.id,
        });
      },
    });
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
    authority: ChatTurnAuthority,
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
}

/** How many times the loop may ask the model to repair a malformed call before giving up. */
const MAX_REPAIR_ATTEMPTS = 2;

const SYSTEM_SOURCE_ID = "system";

/**
 * The Soul reminder's manifest identity.
 *
 * `skill_instructions` ranks it below the Agent's own instructions and leaves it compactable, so a
 * Context that will not fit drops the whole block rather than a truncated half of it.
 */
const SOUL_REMINDER_SOURCE_ID = "soul_reminder";

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
  soulReminder: string,
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
  const reminder: ContextCandidate[] =
    soulReminder.length === 0
      ? []
      : [
          {
            sourceId: SOUL_REMINDER_SOURCE_ID,
            kind: "instruction",
            precedence: "skill_instructions",
            version: "1",
            classification: "internal",
            taint: "trusted",
            authorization: allow,
            tokens: estimateTokens(soulReminder),
            digest: canonicalHash({ soulReminder }),
          },
        ];
  return [
    instruction,
    ...reminder,
    ...[...history].reverse().map(
      (message): ContextCandidate => ({
        sourceId: message.id,
        kind: "message",
        precedence: "user_request",
        version: "1",
        classification: "internal",
        taint: "trusted",
        authorization: allow,
        tokens: estimateTokens(contentText(message.content)),
        digest: canonicalHash({ content: message.content }),
      })
    ),
  ];
}
